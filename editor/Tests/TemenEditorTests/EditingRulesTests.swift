import XCTest
@testable import TemenEditor

/// Each case is text with the selection marked: `|` a cursor, `[` `]` a selection.
final class EditingRulesTests: XCTestCase {
    let js = JavaScriptSubset()
    let opts = EditingRules.Options()

    func parse(_ marked: String) -> ([UInt16], NSRange) {
        var s = marked
        if let c = s.range(of: "|") {
            let loc = s.utf16.distance(from: s.startIndex, to: c.lowerBound)
            s.removeSubrange(c)
            return (Array(s.utf16), NSRange(location: loc, length: 0))
        }
        let a = s.range(of: "[")!
        let loc = s.utf16.distance(from: s.startIndex, to: a.lowerBound)
        s.removeSubrange(a)
        let b = s.range(of: "]")!
        let end = s.utf16.distance(from: s.startIndex, to: b.lowerBound)
        s.removeSubrange(b)
        return (Array(s.utf16), NSRange(location: loc, length: end - loc))
    }

    /// The text after the edit with the new selection marked.
    func result(_ marked: String, _ edit: (([UInt16], NSRange, [Token]) -> TextEdit?)) -> String? {
        let (u, sel) = parse(marked)
        guard let e = edit(u, sel, js.tokenize(u)) else { return nil }
        let s = String(decoding: u, as: UTF16.self) as NSString
        let out = s.replacingCharacters(in: e.range, with: e.text) as NSString
        if e.selection.length == 0 { return out.replacingCharacters(in: e.selection, with: "|") }
        return out.replacingCharacters(in: NSRange(location: e.selection.end, length: 0), with: "]").replacingOccurrences(of: "", with: "")
            .withMarker(at: e.selection.location)
    }

    func type(_ c: String, _ marked: String) -> String? {
        result(marked) { EditingRules.insert(c, text: $0, selection: $1, tokens: $2, options: opts) }
    }

    func testBracketPairs() {
        XCTAssertEqual(type("(", "box|"), "box(|)")
        XCTAssertEqual(type("{", "x = |;"), "x = {|};")
        XCTAssertNil(type("(", "|abc"))          // before a word: just the bracket
        XCTAssertEqual(type(")", "box(1|)"), "box(1)|")   // steps over
        XCTAssertNil(type("(", "'a|'"))           // in a string
        XCTAssertEqual(type("(", "[abc]"), "([abc])")   // wraps
    }

    func testQuotes() {
        XCTAssertEqual(type("'", "x = |"), "x = '|'")
        XCTAssertEqual(type("'", "x = 'abc|'"), "x = 'abc'|")
        XCTAssertNil(type("'", "don|"))
        XCTAssertNil(type("'", "x = 'a|bc'"))
    }

    func testCloserDedents() {
        XCTAssertEqual(type("}", "if (a) {\n  x;\n    |"), "if (a) {\n  x;\n}|")
    }

    func testNewline() {
        let nl = { (m: String) in self.result(m) { EditingRules.newline(text: $0, selection: $1, tokens: $2, options: self.opts) } }
        XCTAssertEqual(nl("  a;|"), "  a;\n  |")
        XCTAssertEqual(nl("f() {|}"), "f() {\n  |\n}")
        XCTAssertEqual(nl("  x = [|"), "  x = [\n    |")
        XCTAssertEqual(nl("a;   |"), "a;\n|")
    }

    func testBackspace() {
        let del = { (m: String) in self.result(m) { EditingRules.deleteBackward(text: $0, selection: $1, tokens: $2, options: self.opts) } }
        XCTAssertEqual(del("f(|)"), "f|")
        XCTAssertEqual(del("x = '|'"), "x = |")
        XCTAssertEqual(del("    |a"), "  |a")
        XCTAssertEqual(del("   |"), "  |")
        XCTAssertNil(del("ab|"))
    }

    func testTabAndIndent() {
        XCTAssertEqual(result("a|") { u, s, _ in EditingRules.tab(text: u, selection: s, options: self.opts) }, "a |")
        XCTAssertEqual(result("[a\nb]") { u, s, _ in EditingRules.indent(text: u, selection: s, options: self.opts, outdent: false) }, "[  a\n  b]")
        XCTAssertEqual(result("  [a\n    b]") { u, s, _ in EditingRules.indent(text: u, selection: s, options: self.opts, outdent: true) }, "[a\n  b]")
    }

    func testToggleComment() {
        let tc = { (m: String) in self.result(m) { u, s, _ in EditingRules.toggleComment(text: u, selection: s, marker: "//") } }
        XCTAssertEqual(tc("  [a;\n    b;]"), "  [// a;\n  //   b;]")
        XCTAssertEqual(tc("  [// a;\n  //   b;]"), "  [a;\n    b;]")
        XCTAssertEqual(tc("x|;"), "// x|;")
    }

    func testBracketMatch() {
        let (u, _) = parse("f(a[1], {b})|")
        let t = js.tokenize(u)
        let m = EditingRules.matchBracket(text: u, tokens: t, cursor: u.count)
        XCTAssertEqual(m?.partner, NSRange(location: 1, length: 1))
        XCTAssertEqual(m?.matched, true)
        let bad = Array("(a]".utf16)
        XCTAssertEqual(EditingRules.matchBracket(text: bad, tokens: js.tokenize(bad), cursor: 3)?.matched, false)
        let tpl = Array("`${a}`".utf16)
        XCTAssertEqual(EditingRules.matchBracket(text: tpl, tokens: js.tokenize(tpl), cursor: 5)?.partner, NSRange(location: 1, length: 2))
    }

    func testLineIndex() {
        let u = Array("a\nbc\r\n\nd\n".utf16)
        let li = LineIndex(u)
        XCTAssertEqual(li.starts, [0, 2, 6, 7, 9])
        XCTAssertEqual(li.line(containing: 3), 1)
        XCTAssertEqual(li.range(ofLine: 1, in: u), NSRange(location: 2, length: 2))
        XCTAssertEqual(li.line(containing: 9), 4)
    }
}

private extension String {
    func withMarker(at loc: Int) -> String {
        (self as NSString).replacingCharacters(in: NSRange(location: loc, length: 0), with: "[")
    }
}
