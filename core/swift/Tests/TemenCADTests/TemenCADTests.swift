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
    func testSyntaxCheck() throws {
        let core = try TemenCore()
        XCTAssertNil(core.checkSyntax(name: "main.js", source: "const a = cube(10);\nreturn a;\n"))
        XCTAssertNil(core.checkSyntax(name: "parts/a.js", source: "import { x } from './nowhere.js';\nexport const y = x;\n"))
        // a column counts UTF-16 units, as the editor does: "é" and an emoji before the error
        let e = core.checkSyntax(name: "main.js", source: "// é 😀\nconst s = '😀'; const b = (1 + ;\n")
        XCTAssertEqual(e?.line, 2)
        XCTAssertEqual(e?.column, 32)
        XCTAssertNotNil(core.checkSyntax(name: "parts/a.js", source: "return 1;"))
        XCTAssertEqual(core.checkSyntax(name: "main.js", source: "if (true) {\n  cube(1);\n"), TemenSyntaxError(message: core.checkSyntax(name: "main.js", source: "if (true) {\n  cube(1);\n")!.message, line: 2, column: nil))
        XCTAssertTrue(core.build(script: "return cube(10);").ok)
    }

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

    func testPointsAndMeasures() throws {
        let r = try TemenCore().build(script: "return box(30, 10, 20).onPlate().subtract(cylinder(3, 30).translate(0, 5, 0)).name('plate')")
        XCTAssertTrue(r.ok, r.error?.message ?? "")
        let part = r.parts[0]
        let picker = try XCTUnwrap(TemenPicker(part))
        var top: Int?, hole: Int?
        for t in 0..<(part.indices.count / 3) {
            guard let s = picker.surface(triangle: t, point: [0, 0, 0]) else { continue }
            if s.label == "plate · top face at y = 10" { top = t }
            if s.label == "plate · Ø6 hole along Y" { hole = t }
        }
        let topTri = try XCTUnwrap(top), holeTri = try XCTUnwrap(hole)
        let face = try XCTUnwrap(picker.surface(triangle: topTri, point: [10, 10, 5]))
        XCTAssertEqual(face.kind, "flat")
        XCTAssertTrue(face.description.hasPrefix("the flat top face (normal +Y) at y = 10, on part \"plate\", clicked at [10, 10, 5]"), face.description)
        let h = try XCTUnwrap(picker.surface(triangle: holeTri, point: [3, 5, 0]))
        XCTAssertEqual(h.shape, "cylinder")
        XCTAssertEqual(h.radius ?? 0, 3, accuracy: 0.05)
        XCTAssertGreaterThan(h.triangles.count, 20)
        var bottom: Int?
        for t in 0..<(part.indices.count / 3) where picker.surface(triangle: t, point: [0, 0, 0])?.label == "plate · bottom face at y = 0" { bottom = t; break }
        let m = try XCTUnwrap(TemenPicker.measure(.init(picker: picker, triangle: topTri, point: [10, 10, 5], snapped: false),
                                                  .init(picker: picker, triangle: try XCTUnwrap(bottom), point: [10, 0, 5], snapped: true)))
        XCTAssertEqual(m.distance, 10, accuracy: 1e-9)
        XCTAssertEqual(m.gap ?? 0, 10, accuracy: 1e-9)
        XCTAssertEqual(m.label, "Measured 10 mm")
        XCTAssertTrue(m.text.contains("(a corner)") && m.text.hasSuffix("the two faces are parallel and 10 mm apart"), m.text)
    }

    func testRendersAViewSheet() throws {
        let core = try TemenCore()
        let r = core.build(script: "dimension([0, 0, 0], [20, 0, 0]); return { a: box(20).onPlate().name('block') }")
        XCTAssertTrue(r.ok, r.error?.message ?? "")
        let png = try core.render(parts: r.parts, views: ["iso", "top"], width: 320, height: 240, section: ("y", 5), annotations: r.annotations)
        XCTAssertEqual(Array(png.prefix(8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        let w = png.subdata(in: 16..<20).reduce(0) { $0 << 8 | Int($1) }, h = png.subdata(in: 20..<24).reduce(0) { $0 << 8 | Int($1) }
        XCTAssertEqual([w, h], [640, 240]) // two views side by side
        XCTAssertThrowsError(try core.render(parts: r.parts, views: ["sideways"]))
    }

    func testConversationRoundTrips() throws {
        let png = Data([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
        let json = """
        {"format":2,"app":"swift test","entries":[{"kind":"user","text":"hi"}],
         "messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"\(png.base64EncodedString())"}}]}],
         "checkpoints":[{"main.js":{"$blob":"one"}}]}
        """
        let entries = try TemenConversation.pack(json: Data(json.utf8), blobs: ["one": Data("return box(1);".utf8)])
        XCTAssertEqual(entries.count, 3) // the json, the image, main.js
        // through a whole .temen and back
        let archive = try TemenArchive.write(entries.merging(["main.js": Data("return box(1);".utf8)]) { a, _ in a })
        let project = try TemenArchive.readProject(archive)
        let c = try XCTUnwrap(try TemenConversation.unpack(project.extras))
        let doc = try XCTUnwrap(try JSONSerialization.jsonObject(with: c.json) as? [String: Any])
        let source = (((doc["messages"] as? [[String: Any]])?[0]["content"] as? [[String: Any]])?[0]["source"] as? [String: Any])
        XCTAssertEqual(source?["data"] as? String, png.base64EncodedString())
        let key = (((doc["checkpoints"] as? [[String: Any]])?[0]["main.js"]) as? [String: Any])?["$blob"] as? String
        XCTAssertEqual(key.flatMap { c.blobs[$0] }, Data("return box(1);".utf8))
        XCTAssertNil(try TemenConversation.unpack(["main.js": Data()]))
        XCTAssertThrowsError(try TemenConversation.pack(json: Data(#"{"format":1,"entries":[],"messages":[]}"#.utf8)))
    }
}
