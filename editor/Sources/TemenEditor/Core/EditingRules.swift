import Foundation

/// An edit the editor makes in place of what was typed: replace `range` with `text` and select
/// `selection` (in the new text). An empty range and text only moves the selection.
public struct TextEdit: Equatable {
    public var range: NSRange
    public var text: String
    public var selection: NSRange

    public init(range: NSRange, text: String, selection: NSRange) {
        self.range = range
        self.text = text
        self.selection = selection
    }

    var isSelectionOnly: Bool { range.length == 0 && text.isEmpty }
}

/// What happens on typing a bracket or a quote, Return, Tab, Backspace and Command-/, as plain functions
/// of the text, the selection and its tokens.
public enum EditingRules {
    typealias C = UTF16Char

    public struct Options: Equatable {
        /// One level of indentation: spaces, or a tab.
        public var indentUnit: String
        /// Type a closing bracket or quote with the opening one.
        public var closeBrackets: Bool
        public init(indentUnit: String = "  ", closeBrackets: Bool = true) {
            self.indentUnit = indentUnit
            self.closeBrackets = closeBrackets
        }
        var indentWidth: Int { indentUnit == "\t" ? 1 : indentUnit.utf16.count }
    }

    static func lineStart(_ s: [UInt16], _ p: Int) -> Int {
        var i = min(p, s.count)
        while i > 0 && s[i - 1] != C.newline && s[i - 1] != C.cr { i -= 1 }
        return i
    }

    static func lineEnd(_ s: [UInt16], _ p: Int) -> Int {
        var i = max(0, p)
        while i < s.count && s[i] != C.newline && s[i] != C.cr { i += 1 }
        return i
    }

    static func indentation(_ s: [UInt16], lineStart a: Int) -> String {
        var i = a
        while i < s.count && (s[i] == C.space || s[i] == C.tab) { i += 1 }
        return s.string(NSRange(location: a, length: i - a))
    }

    /// Whether `p` is inside a string, comment or regular expression (where brackets are just text).
    static func inLiteral(_ s: [UInt16], _ tokens: [Token], _ p: Int) -> Bool {
        guard let t = tokens.token(around: p), t.location < p else { return false }
        switch t.kind {
        case .comment:
            if p < t.end { return true }
            return !(s[t.location + 1] == C.star && t.length >= 4 && s[t.end - 2] == C.star && s[t.end - 1] == C.slash)
        case .string:
            if p < t.end { return true }
            let first = s[t.location], last = s[t.end - 1]
            return first == C.quote || first == C.apostrophe ? !(t.length >= 2 && last == first)
                : !(last == C.backtick && (t.length >= 2 || first != C.backtick))
        case .regex: return p < t.end
        default: return false
        }
    }

    private static func pairsBefore(_ c: UInt16?) -> Bool {
        guard let c else { return true }
        return C.isWhitespace(c) || C.isCloser(c) || c == C.comma || c == C.semicolon || c == C.colon
    }

    /// Typing one character: bracket and quote pairs, stepping over a closer, wrapping a selection,
    /// and a closing brace typed on an empty line going back to the indentation of its opener.
    public static func insert(_ typed: String, text s: [UInt16], selection sel: NSRange, tokens: [Token], options: Options) -> TextEdit? {
        guard options.closeBrackets, typed.utf16.count == 1, let c = typed.utf16.first else { return nil }
        let isQuote = c == C.quote || c == C.apostrophe || c == C.backtick
        guard C.isOpener(c) || C.isCloser(c) || isQuote else { return nil }
        let pos = sel.location
        let next: UInt16? = sel.end < s.count ? s[sel.end] : nil
        let prev: UInt16? = pos > 0 ? s[pos - 1] : nil
        let typedStr = String(decoding: [c], as: UTF16.self)

        if sel.length > 0, C.isOpener(c) || isQuote {
            let close = String(decoding: [C.closer(for: c) ?? c], as: UTF16.self)
            let inner = s.string(sel)
            return TextEdit(range: sel, text: typedStr + inner + close, selection: NSRange(location: pos + 1, length: sel.length))
        }
        let literal = inLiteral(s, tokens, pos)
        if C.isOpener(c) {
            guard !literal, pairsBefore(next) else { return nil }
            let close = String(decoding: [C.closer(for: c)!], as: UTF16.self)
            return TextEdit(range: sel, text: typedStr + close, selection: NSRange(location: pos + 1, length: 0))
        }
        if C.isCloser(c) {
            guard sel.length == 0, !literal else { return nil }
            if next == c { return TextEdit(range: NSRange(location: pos, length: 0), text: "", selection: NSRange(location: pos + 1, length: 0)) }
            // a closer typed in the indentation goes back to its opener's indentation
            let a = lineStart(s, pos)
            if s[a..<pos].allSatisfy({ $0 == C.space || $0 == C.tab }), pos > a, let open = openerLine(s, tokens, before: a) {
                let indent = indentation(s, lineStart: open)
                if indent.utf16.count != pos - a {
                    return TextEdit(range: NSRange(location: a, length: pos - a), text: indent + typedStr,
                                    selection: NSRange(location: a + indent.utf16.count + 1, length: 0))
                }
            }
            return nil
        }
        // quotes
        if sel.length == 0, next == c, let t = tokens.token(around: pos + 1), t.kind == .string, t.end == pos + 1, t.location < pos {
            return TextEdit(range: NSRange(location: pos, length: 0), text: "", selection: NSRange(location: pos + 1, length: 0))
        }
        guard !literal else { return nil }
        if let p = prev, C.isIdentifierPart(p) || p == c { return nil }
        guard pairsBefore(next) else { return nil }
        return TextEdit(range: sel, text: typedStr + typedStr, selection: NSRange(location: pos + 1, length: 0))
    }

    /// Start of the line holding the innermost unclosed opener before `p`.
    static func openerLine(_ s: [UInt16], _ tokens: [Token], before p: Int) -> Int? {
        guard var k = tokens.lastIndex(startingBefore: p) else { return nil }
        var depth = 0
        while k >= 0 {
            let t = tokens[k]
            if t.kind == .bracket {
                let ch = s[t.location]
                if C.isCloser(ch) { depth += 1 }
                else if depth == 0 { return lineStart(s, t.location) }
                else { depth -= 1 }
            }
            k -= 1
        }
        return nil
    }

    /// Backspace: an empty pair goes as one, and in the indentation it removes one level.
    public static func deleteBackward(text s: [UInt16], selection sel: NSRange, tokens: [Token], options: Options) -> TextEdit? {
        guard sel.length == 0, sel.location > 0 else { return nil }
        let pos = sel.location
        let prev = s[pos - 1]
        if options.closeBrackets, pos < s.count {
            let next = s[pos]
            let pair = (C.closer(for: prev) == next) || ((prev == C.quote || prev == C.apostrophe || prev == C.backtick) && next == prev)
            if pair && !(C.isOpener(prev) == false && inLiteral(s, tokens, pos - 1)) {
                return TextEdit(range: NSRange(location: pos - 1, length: 2), text: "", selection: NSRange(location: pos - 1, length: 0))
            }
        }
        let a = lineStart(s, pos)
        let w = options.indentWidth
        if options.indentUnit != "\t", pos > a, s[a..<pos].allSatisfy({ $0 == C.space }) {
            let col = pos - a
            let target = ((col - 1) / w) * w
            return TextEdit(range: NSRange(location: a + target, length: col - target), text: "", selection: NSRange(location: a + target, length: 0))
        }
        return nil
    }

    /// Return: keeps the indentation, adds a level after an opener, and puts the closer of an empty pair
    /// on its own line.
    public static func newline(text s: [UInt16], selection sel: NSRange, tokens: [Token], options: Options) -> TextEdit {
        let pos = sel.location
        let a = lineStart(s, pos)
        var indent = indentation(s, lineStart: a)
        if indent.utf16.count > pos - a { indent = s.string(NSRange(location: a, length: pos - a)) }
        var b = pos
        while b > a && (s[b - 1] == C.space || s[b - 1] == C.tab) { b -= 1 }
        let prev: UInt16? = b > a ? s[b - 1] : nil
        var e = sel.end
        while e < s.count && (s[e] == C.space || s[e] == C.tab) { e += 1 }
        let next: UInt16? = e < s.count ? s[e] : nil
        let literal = inLiteral(s, tokens, pos)
        if let p = prev, C.isOpener(p), !literal {
            let inner = indent + options.indentUnit
            if let n = next, C.closer(for: p) == n {
                let text = "\n" + inner + "\n" + indent
                return TextEdit(range: NSRange(location: b, length: e - b), text: text,
                                selection: NSRange(location: b + 1 + inner.utf16.count, length: 0))
            }
            return TextEdit(range: NSRange(location: b, length: e - b), text: "\n" + inner,
                            selection: NSRange(location: b + 1 + inner.utf16.count, length: 0))
        }
        return TextEdit(range: NSRange(location: b, length: e - b), text: "\n" + indent,
                        selection: NSRange(location: b + 1 + indent.utf16.count, length: 0))
    }

    /// Tab: with a selection, indents its lines; otherwise inserts spaces to the next tab stop.
    public static func tab(text s: [UInt16], selection sel: NSRange, options: Options) -> TextEdit {
        if sel.length > 0 { return indent(text: s, selection: sel, options: options, outdent: false) ?? TextEdit(range: sel, text: options.indentUnit, selection: NSRange(location: sel.location + options.indentUnit.utf16.count, length: 0)) }
        if options.indentUnit == "\t" { return TextEdit(range: sel, text: "\t", selection: NSRange(location: sel.location + 1, length: 0)) }
        let col = sel.location - lineStart(s, sel.location)
        let w = options.indentWidth
        let spaces = String(repeating: " ", count: w - col % w)
        return TextEdit(range: sel, text: spaces, selection: NSRange(location: sel.location + spaces.utf16.count, length: 0))
    }

    /// The lines a selection touches: from the start of its first line to the end of its last (a
    /// selection ending at the start of a line leaves that line out).
    static func lineBlock(_ s: [UInt16], _ sel: NSRange) -> NSRange {
        let a = lineStart(s, sel.location)
        var endPos = sel.end
        if sel.length > 0 && endPos > sel.location && lineStart(s, endPos) == endPos { endPos -= 1 }
        let b = lineEnd(s, max(endPos, a))
        return NSRange(location: a, length: b - a)
    }

    /// Rewrites each line of the block and maps the selection: a position keeps its place in the text of
    /// its line, staying put when the change on that line comes after it.
    static func transformLines(_ s: [UInt16], _ sel: NSRange, _ f: (String) -> String) -> TextEdit? {
        let block = lineBlock(s, sel)
        let old = s.string(block)
        let oldLines = old.components(separatedBy: "\n")
        let newLines = oldLines.map(f)
        let new = newLines.joined(separator: "\n")
        guard new != old else { return nil }
        func map(_ pos: Int) -> Int {
            var offset = block.location, delta = 0
            for (o, n) in zip(oldLines, newLines) {
                let ou = Array(o.utf16), nu = Array(n.utf16)
                if pos <= offset + ou.count {
                    let col = pos - offset
                    var common = 0
                    while common < ou.count && common < nu.count && ou[common] == nu[common] { common += 1 }
                    let newCol = col <= common ? col : max(common, min(nu.count, col + nu.count - ou.count))
                    return offset + delta + newCol
                }
                offset += ou.count + 1
                delta += nu.count - ou.count
            }
            return pos + delta
        }
        let start = map(sel.location)
        let end = sel.length == 0 ? start : max(start, map(sel.end))
        return TextEdit(range: block, text: new, selection: NSRange(location: start, length: end - start))
    }

    /// Indents (or outdents) the non-blank lines the selection touches by one level.
    public static func indent(text s: [UInt16], selection sel: NSRange, options: Options, outdent: Bool) -> TextEdit? {
        transformLines(s, sel) { line in
            if outdent {
                if line.hasPrefix("\t") { return String(line.dropFirst()) }
                let spaces = line.prefix { $0 == " " }.count
                return String(line.dropFirst(min(spaces, options.indentWidth)))
            }
            return line.trimmingCharacters(in: .whitespaces).isEmpty ? line : options.indentUnit + line
        }
    }

    /// Command-/: comments out the lines (at their least indentation) or, when all are comments, uncomments them.
    public static func toggleComment(text s: [UInt16], selection sel: NSRange, marker: String) -> TextEdit? {
        let block = lineBlock(s, sel)
        let lines = s.string(block).components(separatedBy: "\n")
        let code = lines.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        guard !code.isEmpty else { return nil }
        let commented = code.allSatisfy { $0.trimmingCharacters(in: .whitespaces).hasPrefix(marker) }
        let minIndent = code.map { $0.prefix { $0 == " " || $0 == "\t" }.count }.min() ?? 0
        return transformLines(s, sel) { line in
            if line.trimmingCharacters(in: .whitespaces).isEmpty { return line }
            if commented {
                let ws = line.prefix { $0 == " " || $0 == "\t" }
                var rest = line.dropFirst(ws.count).dropFirst(marker.count)
                if rest.hasPrefix(" ") { rest = rest.dropFirst() }
                return String(ws) + rest
            }
            let i = line.index(line.startIndex, offsetBy: minIndent)
            return String(line[..<i]) + marker + " " + line[i...]
        }
    }

    /// The bracket at the cursor (before it first, then after it) and its partner.
    public struct BracketMatch: Equatable {
        public var bracket: NSRange
        public var partner: NSRange?
        public var matched: Bool
    }

    public static func matchBracket(text s: [UInt16], tokens: [Token], cursor: Int) -> BracketMatch? {
        func ch(_ t: Token) -> UInt16 { s[t.location] == C.dollar ? C.lbrace : s[t.location] }
        var index: Int? = nil
        if let i = tokens.lastIndex(startingBefore: cursor), tokens[i].kind == .bracket, tokens[i].end == cursor { index = i }
        else if let i = tokens.lastIndex(startingBefore: cursor + 1), tokens[i].kind == .bracket, tokens[i].location == cursor { index = i }
        guard let i = index else { return nil }
        let t = tokens[i], c = ch(t)
        var stack: [UInt16] = []
        if C.isOpener(c) {
            var k = i + 1
            while k < tokens.count {
                let u = tokens[k]
                if u.kind == .bracket {
                    let d = ch(u)
                    if C.isOpener(d) { stack.append(d) }
                    else if let top = stack.popLast() { if C.closer(for: top) != d { return BracketMatch(bracket: t.range, partner: nil, matched: false) } }
                    else { return BracketMatch(bracket: t.range, partner: u.range, matched: C.closer(for: c) == d) }
                }
                k += 1
            }
        } else {
            var k = i - 1
            while k >= 0 {
                let u = tokens[k]
                if u.kind == .bracket {
                    let d = ch(u)
                    if C.isCloser(d) { stack.append(d) }
                    else if let top = stack.popLast() { if C.closer(for: d) != top { return BracketMatch(bracket: t.range, partner: nil, matched: false) } }
                    else { return BracketMatch(bracket: t.range, partner: u.range, matched: C.closer(for: d) == c) }
                }
                k -= 1
            }
        }
        return BracketMatch(bracket: t.range, partner: nil, matched: false)
    }
}
