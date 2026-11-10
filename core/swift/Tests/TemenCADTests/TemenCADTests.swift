import XCTest
@testable import TemenCAD

final class TemenCADTests: XCTestCase {
    func testCubeBuilds() throws {
        let core = try TemenCore()
        let r = core.build(script: "echo('v', box(10).volume()); return box(10).onPlate().name('block')")
        XCTAssertTrue(r.ok, r.error?.message ?? "")
        XCTAssertEqual(r.parts.count, 1)
        XCTAssertEqual(r.parts[0].name, "block")
        XCTAssertEqual(r.parts[0].volume, 1000, accuracy: 1e-9)
        XCTAssertEqual(r.parts[0].indices.count, 36)
        let minY = stride(from: 1, to: r.parts[0].positions.count, by: 3).map { r.parts[0].positions[$0] }.min()!
        XCTAssertEqual(minY, 0, accuracy: 1e-6)
        XCTAssertEqual(r.messages.first?.text, "ECHO (line 1): \"v\", 1000")
        XCTAssertEqual(r.messages.first?.line, 1)
    }

    func testProjectWithImportsTextAndProfile() throws {
        let core = try TemenCore()
        let r = core.build(files: [
            "main.js": Data("import { peg } from './parts/peg.js'; printer({ nozzle: 0.6 }); dimension([0, 0, 0], [0, 10, 0]); return { peg: peg(), tag: text3d('3D', { size: 12, height: 3 }) }".utf8),
            "parts/peg.js": Data("export function peg() { return cylinder(1, 10, { segments: 16 }); }".utf8),
        ])
        XCTAssertTrue(r.ok, r.error?.message ?? "")
        XCTAssertEqual(r.parts.map(\.name), ["peg", "tag"])
        XCTAssertGreaterThan(r.parts[1].volume, 50)
        XCTAssertEqual(r.profile?.nozzle, 0.6)
        XCTAssertEqual(r.annotations.count, 1)
        XCTAssertTrue(r.annotations[0].contains("\"type\":\"dimension\""))
    }

    func testErrorsNameTheScriptLine() throws {
        let core = try TemenCore()
        let r = core.build(script: "const w = 5;\nassert(w > 10, 'too narrow');\nreturn box(w)")
        XCTAssertFalse(r.ok)
        XCTAssertEqual(r.error?.message, "Assertion failed: too narrow")
        XCTAssertEqual(r.error?.file, "main.js")
        XCTAssertEqual(r.error?.line, 2)
        // and the core keeps working afterwards
        XCTAssertTrue(core.build(script: "return sphere(2)").ok)
    }

    /// core/test/project.temen was written by fflate, as the web app saves projects.
    func testReadsAWebProject() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../test/project.temen").standardized
        let project = try TemenArchive.readProject(try Data(contentsOf: url))
        XCTAssertEqual(project.files.keys.sorted(), ["main.js", "parts/peg.js"])
        XCTAssertEqual(project.extras.keys.sorted(), [".assistant/chat.json"])
        let r = try TemenCore().build(files: project.files)
        XCTAssertTrue(r.ok, r.error?.message ?? "")
        XCTAssertEqual(r.parts.map(\.name), ["a"])
    }

    func testArchiveRoundTripAndRules() throws {
        let files: [String: Data] = [
            "widget.js": Data("return sphere(5)".utf8), "Logo.ttf": Data([0, 1, 2, 255]), "empty.txt": Data(),
            ".assistant/chat.json": Data("{}".utf8), "parts/./x/../.hidden": Data("x".utf8), "__MACOSX/._widget.js": Data("x".utf8),
        ]
        let zip = try TemenArchive.write(files, level: 9)
        XCTAssertEqual(try TemenArchive.read(zip), files)
        let project = try TemenArchive.readProject(zip)
        XCTAssertEqual(project.files, ["main.js": files["widget.js"]!, "Logo.ttf": files["Logo.ttf"]!, "empty.txt": Data()])
        XCTAssertEqual(project.extras, [".assistant/chat.json": Data("{}".utf8)])
        XCTAssertThrowsError(try TemenArchive.readProject(try TemenArchive.write(["a.js": Data(), "b.js": Data()]))) {
            XCTAssertEqual(($0 as? TemenArchiveError)?.message, "the project has no main.js")
        }
        XCTAssertThrowsError(try TemenArchive.read(Data("not a zip".utf8)))
    }

    func testExportsSTLAnd3MF() throws {
        let r = try TemenCore().build(script: "return { a: box(10).onPlate().color('#ff8000'), b: sphere(3).translate(20, 3, 0).name('b & <c>') }")
        XCTAssertTrue(r.ok, r.error?.message ?? "")
        let stl = try TemenExport.stl(r.parts)
        let tris = r.parts.reduce(0) { $0 + $1.indices.count / 3 }
        XCTAssertEqual(stl.count, 84 + tris * 50)
        XCTAssertEqual(stl.subdata(in: 80..<84).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }, UInt32(tris))
        XCTAssertEqual(String(decoding: stl.prefix(19), as: UTF8.self), "TemenCAD binary STL")
        let zip = try TemenArchive.read(try TemenExport.threeMF(r.parts))
        XCTAssertEqual(zip.keys.sorted(), ["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"])
        let model = String(decoding: zip["3D/3dmodel.model"]!, as: UTF8.self)
        XCTAssertTrue(model.contains("<base name=\"a\" displaycolor=\"#FF8000\" />"), model.prefix(600).description)
        XCTAssertTrue(model.contains("name=\"b &amp; &lt;c&gt;\""))
        XCTAssertThrowsError(try TemenExport.stl([]))
    }
}
