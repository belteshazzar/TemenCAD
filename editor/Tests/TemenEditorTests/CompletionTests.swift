import XCTest
@testable import TemenEditor

final class CompletionTests: XCTestCase {
    let js = JavaScriptSubset()

    /// The context at `|` in the source.
    func context(_ marked: String, explicit: Bool = false) -> CompletionContext? {
        let cursor = (marked as NSString).range(of: "|").location
        let s = marked.replacingOccurrences(of: "|", with: "")
        let u = Array(s.utf16)
        return js.completionContext(text: u, tokens: js.tokenize(u), cursor: cursor, explicit: explicit)
    }

    func testGlobalAndMember() {
        XCTAssertEqual(context("const a = bo|")?.kind, .global)
        XCTAssertEqual(context("const a = bo|")?.prefix, "bo")
        XCTAssertEqual(context("plate.tra|")?.kind, .member(receiver: "plate"))
        XCTAssertEqual(context("box(1).|")?.kind, .member(receiver: nil))
        XCTAssertEqual(context("box(1).|")?.prefix, "")
        XCTAssertEqual(context("roundedB|ox(1)")?.range, NSRange(location: 0, length: 8))
    }

    func testNoneInLiteralsOrDeclarations() {
        XCTAssertNil(context("'bo|'"))
        XCTAssertNil(context("// bo|"))
        XCTAssertNil(context("/* bo| */"))
        XCTAssertNil(context("`a ${x} bo|`"))
        XCTAssertNil(context("1.|"))
        XCTAssertNil(context("let bo|"))
        XCTAssertNil(context("function bo|"))
        XCTAssertNil(context("x = |"))
        XCTAssertNotNil(context("x = |", explicit: true))
        XCTAssertEqual(context("`a ${bo|}`")?.prefix, "bo")
        XCTAssertEqual(context("'s' + bo|")?.prefix, "bo")
    }

    func testMatcher() {
        XCTAssertEqual(CompletionMatcher.match("box", "bo")?.positions, [0, 1])
        XCTAssertNotNil(CompletionMatcher.match("roundedBox", "rB"))
        XCTAssertEqual(CompletionMatcher.match("roundedBox", "rB")?.positions, [0, 7])
        XCTAssertEqual(CompletionMatcher.match("roundedBox", "box")?.positions, [7, 8, 9])
        XCTAssertNil(CompletionMatcher.match("box", "bx z"))
        let ranked = CompletionMatcher.rank([Completion(label: "roundedBox"), Completion(label: "box"), Completion(label: "bezier")], prefix: "b").map(\.0.label)
        XCTAssertEqual(ranked, ["box", "bezier", "roundedBox"])
    }

    func testDocumentNames() {
        let s = "const size = 3;\nfunction bracket(w, { depth }) { return w; }\nconst { a, b: c } = o;\nlist.map((item, i) => item);\n"
        let u = Array(s.utf16)
        let names = Set(js.languageCompletions(text: u, tokens: js.tokenize(u)).filter { $0.kind != .keyword && $0.kind != .constant }.map(\.label))
        XCTAssertEqual(names, ["size", "bracket", "w", "depth", "a", "c", "item", "i"])
    }

    func testSnippet() {
        let s = Snippet(template: "box(${w}, ${h}, ${d})")
        XCTAssertEqual(s.text, "box(w, h, d)")
        XCTAssertEqual(s.fields, [NSRange(location: 4, length: 1), NSRange(location: 7, length: 1), NSRange(location: 10, length: 1), NSRange(location: 12, length: 0)])
        XCTAssertEqual(Snippet(template: "f(${1:x})${}").fields.count, 2)
        XCTAssertEqual(Snippet(template: "plain").fields, [])
    }

    func testSnippetSessionFollowsEdits() {
        var sn = SnippetSession(fields: [NSRange(location: 4, length: 1), NSRange(location: 7, length: 1)], current: 0)
        // replace "w" with "40" (range in the new text 4..<6, +1)
        XCTAssertTrue(sn.adjust(editedRange: NSRange(location: 4, length: 2), delta: 1))
        XCTAssertEqual(sn.fields, [NSRange(location: 4, length: 2), NSRange(location: 8, length: 1)])
        // an edit before everything ends it
        XCTAssertFalse(sn.adjust(editedRange: NSRange(location: 0, length: 1), delta: 1))
    }
}
