import XCTest
@testable import TemenEditor

final class TokenizerTests: XCTestCase {
    let js = JavaScriptSubset()

    func kinds(_ s: String) -> [(String, TokenKind)] {
        let u = Array(s.utf16)
        return js.tokenize(u).map { (u.string($0.range), $0.kind) }
    }

    func testKeywordsDefinitionsCalls() {
        let k = kinds("const plate = box(40, 4, 30).translate([0, 2, 0]);")
        XCTAssertEqual(k.map(\.0), ["const", "plate", "=", "box", "(", "40", ",", "4", ",", "30", ")", ".", "translate", "(", "[", "0", ",", "2", ",", "0", "]", ")", ";"])
        XCTAssertEqual(k[0].1, .keyword)
        XCTAssertEqual(k[1].1, .definition)
        XCTAssertEqual(k[3].1, .function)
        XCTAssertEqual(k[5].1, .number)
        XCTAssertEqual(k[12].1, .function)
    }

    func testPropertiesAndConstants() {
        let k = kinds("a.size?.x; true; null; this.y")
        XCTAssertEqual(k.first { $0.0 == "size" }?.1, .property)
        XCTAssertEqual(k.first { $0.0 == "x" }?.1, .property)
        XCTAssertEqual(k.first { $0.0 == "?." }?.1, .punctuation)
        XCTAssertEqual(k.first { $0.0 == "true" }?.1, .constant)
        XCTAssertEqual(k.first { $0.0 == "this" }?.1, .keyword)
    }

    func testUnsupportedWordsAreInvalid() {
        for w in ["var", "class", "instanceof", "debugger", "with"] {
            XCTAssertEqual(kinds("\(w) x").first?.1, .invalid, w)
        }
    }

    func testStringsAndComments() {
        let k = kinds("'a\\'b' \"c\" // note\n/* block\n */ x")
        XCTAssertEqual(k.map(\.1), [.string, .string, .comment, .comment, .identifier])
        XCTAssertEqual(k[0].0, "'a\\'b'")
        XCTAssertEqual(k[2].0, "// note")
        // unterminated string stops at the line end
        XCTAssertEqual(kinds("'abc\nx").map(\.1), [.string, .identifier])
    }

    func testTemplateSubstitutions() {
        let k = kinds("`w=${size.w + {a:1}.a}mm ${`in${x}`}`")
        XCTAssertEqual(k.map(\.0), ["`w=", "${", "size", ".", "w", "+", "{", "a", ":", "1", "}", ".", "a", "}", "mm ", "${", "`in", "${", "x", "}", "`", "}", "`"])
        XCTAssertEqual(k[0].1, .string)
        XCTAssertEqual(k[1].1, .bracket)
        XCTAssertEqual(k[13].1, .bracket)
        XCTAssertEqual(k[14].1, .string)
        XCTAssertEqual(k.last?.1, .string)
    }

    func testRegexOrDivision() {
        XCTAssertEqual(kinds("a / b / c").map(\.1), [.identifier, .operator, .identifier, .operator, .identifier])
        XCTAssertEqual(kinds("x = /ab[/]c/g.test(s)").map(\.1)[2], .regex)
        XCTAssertEqual(kinds("x = /ab[/]c/g.test(s)").map(\.0)[2], "/ab[/]c/g")
        XCTAssertEqual(kinds("return /x/").map(\.1), [.keyword, .regex])
        XCTAssertEqual(kinds("f(a) / 2").map(\.1)[4], .operator)
    }

    func testNumbers() {
        XCTAssertEqual(kinds("0x1F 1.5e-3 .5 7").map(\.1), [.number, .number, .number, .number])
        XCTAssertEqual(kinds("1.5").count, 1)
    }

    func testOperators() {
        XCTAssertEqual(kinds("a ??= b === c => ...d").map(\.0), ["a", "??=", "b", "===", "c", "=>", "...", "d"])
    }

    func testCoversEveryCharacterOutsideWhitespace() {
        let src = "import { x } from './a.js';\nexport default function main() {\n  return `${x}`; // done\n}\n"
        let u = Array(src.utf16)
        var covered = [Bool](repeating: false, count: u.count)
        var last = 0
        for t in js.tokenize(u) {
            XCTAssertGreaterThanOrEqual(t.location, last)
            last = t.end
            for i in t.location..<t.end { covered[i] = true }
        }
        for (i, c) in u.enumerated() where !covered[i] { XCTAssertTrue(UTF16Char.isWhitespace(c), "uncovered \(i)") }
    }
}
