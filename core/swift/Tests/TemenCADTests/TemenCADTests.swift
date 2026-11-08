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
}
