import Foundation

/// The JavaScript that lamassu runs: ES modules in strict mode, `let`/`const`, template literals,
/// regular expressions, destructuring, async/await. The words lamassu reserves or rejects (`var`,
/// `class`, `instanceof`, …) are marked invalid, numeric separators and BigInt literals are not numbers.
public struct JavaScriptSubset: CodeLanguage {
    public init() {}

    /// lamassu's keywords (js_lexer.c) and the contextual words of the module syntax.
    public static let keywords: Set<String> = [
        "await", "break", "case", "catch", "const", "continue", "default", "delete", "do", "else", "export",
        "finally", "for", "function", "if", "import", "in", "let", "new", "return", "switch", "this", "throw",
        "try", "typeof", "void", "while", "of", "async", "from", "as",
    ]
    /// Reserved or deliberately unsupported (js_lexer.c js_reserved, and instanceof, which the parser rejects).
    public static let invalid: Set<String> = [
        "var", "class", "extends", "super", "with", "enum", "yield", "static", "implements", "interface",
        "package", "private", "protected", "public", "debugger", "instanceof",
    ]
    public static let constants: Set<String> = ["true", "false", "null", "undefined", "NaN", "Infinity"]
    /// After these a `/` starts a regular expression.
    static let regexAfterKeywords: Set<String> = ["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "await"]

    public var lineComment: String? { "//" }

    private enum Context { case template, substitution(depth: Int) }

    private static let operators: [[UInt16]] = [
        ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
        "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>",
    ].map { Array($0.utf16) }

    public func tokenize(_ s: [UInt16]) -> [Token] {
        typealias C = UTF16Char
        var tokens: [Token] = []
        tokens.reserveCapacity(s.count / 4)
        var stack: [Context] = []
        var lastSignificant: Int? = nil // index in tokens, comments excluded
        let n = s.count
        var i = 0

        func emit(_ kind: TokenKind, _ start: Int, _ end: Int) {
            tokens.append(Token(kind, start, end - start))
            if kind != .comment { lastSignificant = tokens.count - 1 }
        }
        func text(_ t: Token) -> String { s.string(t.range) }

        /// A piece of a template literal from `from`, the token starting at `start`; ends at the closing
        /// backtick (leaving the template), at `${` (entering a substitution) or at the end of the text.
        func templatePiece(start: Int, from: Int) -> Int {
            var j = from
            while j < n {
                let c = s[j]
                if c == C.backslash { j += 2; continue }
                if c == C.backtick {
                    stack.removeLast()
                    emit(.string, start, j + 1)
                    return j + 1
                }
                if c == C.dollar, j + 1 < n, s[j + 1] == C.lbrace {
                    if j > start { emit(.string, start, j) }
                    emit(.bracket, j, j + 2)
                    stack.append(.substitution(depth: 0))
                    return j + 2
                }
                j += 1
            }
            if n > start { emit(.string, start, n) }
            return n
        }

        func regexAllowed() -> Bool {
            guard let li = lastSignificant else { return true }
            let t = tokens[li]
            switch t.kind {
            case .operator: let o = text(t); return o != "++" && o != "--"
            case .punctuation: return text(t) == "," || text(t) == ";"
            case .bracket: let c = s[t.location]; return !(c == C.rparen || c == C.rbracket || c == C.rbrace)
            case .keyword: return Self.regexAfterKeywords.contains(text(t))
            default: return false
            }
        }

        while i < n {
            if case .template? = stack.last {
                i = templatePiece(start: i, from: i)
                continue
            }
            let c = s[i]
            if C.isWhitespace(c) { i += 1; continue }
            let next: UInt16 = i + 1 < n ? s[i + 1] : 0

            // comments
            if c == C.slash && next == C.slash {
                var j = i + 2
                while j < n && s[j] != C.newline && s[j] != C.cr { j += 1 }
                emit(.comment, i, j); i = j; continue
            }
            if c == C.slash && next == C.star {
                var j = i + 2
                while j < n && !(s[j] == C.star && j + 1 < n && s[j + 1] == C.slash) { j += 1 }
                j = min(n, j + 2)
                emit(.comment, i, j); i = j; continue
            }
            // strings
            if c == C.quote || c == C.apostrophe {
                var j = i + 1
                while j < n {
                    let d = s[j]
                    if d == C.backslash { j += 2; continue }
                    if d == c { j += 1; break }
                    if d == C.newline || d == C.cr { break }
                    j += 1
                }
                j = min(j, n)
                emit(.string, i, j); i = j; continue
            }
            if c == C.backtick {
                stack.append(.template)
                i = templatePiece(start: i, from: i + 1)
                continue
            }
            // numbers
            if C.isDigit(c) || (c == C.dot && C.isDigit(next)) {
                var j = i
                if c == 48, next == 120 || next == 88 || next == 98 || next == 66 || next == 111 || next == 79 {
                    j += 2
                    while j < n, let _ = hexValue(s[j]) { j += 1 }
                } else {
                    while j < n && C.isDigit(s[j]) { j += 1 }
                    if j < n && s[j] == C.dot { j += 1; while j < n && C.isDigit(s[j]) { j += 1 } }
                    if j < n && (s[j] == 101 || s[j] == 69) {
                        var k = j + 1
                        if k < n && (s[k] == 43 || s[k] == 45) { k += 1 }
                        if k < n && C.isDigit(s[k]) { j = k; while j < n && C.isDigit(s[j]) { j += 1 } }
                    }
                }
                emit(.number, i, j); i = j; continue
            }
            // names
            if C.isIdentifierStart(c) {
                var j = i + 1
                while j < n && C.isIdentifierPart(s[j]) { j += 1 }
                let word = s.string(NSRange(location: i, length: j - i))
                var kind: TokenKind
                let prev = lastSignificant.map { tokens[$0] }
                let prevText = prev.map(text)
                if Self.invalid.contains(word) { kind = .invalid }
                else if Self.keywords.contains(word) && prevText != "." && prevText != "?." { kind = .keyword }
                else if Self.constants.contains(word) && prevText != "." && prevText != "?." { kind = .constant }
                else {
                    var k = j
                    while k < n && C.isWhitespace(s[k]) { k += 1 }
                    let called = k < n && s[k] == C.lparen
                    if prev?.kind == .punctuation && (prevText == "." || prevText == "?.") { kind = called ? .function : .property }
                    else if prev?.kind == .keyword && (prevText == "let" || prevText == "const" || prevText == "function") { kind = .definition }
                    else { kind = called ? .function : .identifier }
                }
                emit(kind, i, j); i = j; continue
            }
            // regular expressions
            if c == C.slash && regexAllowed() {
                var j = i + 1, inClass = false, closed = false
                while j < n {
                    let d = s[j]
                    if d == C.backslash { j += 2; continue }
                    if d == C.newline || d == C.cr { break }
                    if d == C.lbracket { inClass = true } else if d == C.rbracket { inClass = false }
                    else if d == C.slash && !inClass { closed = true; j += 1; break }
                    j += 1
                }
                if closed {
                    while j < n && C.isIdentifierPart(s[j]) { j += 1 }
                    emit(.regex, i, j); i = j; continue
                }
            }
            // brackets
            if C.isOpener(c) || C.isCloser(c) {
                if c == C.lbrace, case .substitution(let d)? = stack.last { stack[stack.count - 1] = .substitution(depth: d + 1) }
                if c == C.rbrace, case .substitution(let d)? = stack.last {
                    if d == 0 { emit(.bracket, i, i + 1); stack.removeLast(); i += 1; continue }
                    stack[stack.count - 1] = .substitution(depth: d - 1)
                }
                emit(.bracket, i, i + 1); i += 1; continue
            }
            // punctuation and operators
            if c == C.question && next == C.dot && !(i + 2 < n && C.isDigit(s[i + 2])) { emit(.punctuation, i, i + 2); i += 2; continue }
            if c == C.comma || c == C.semicolon || (c == C.dot && !(next == C.dot && i + 2 < n && s[i + 2] == C.dot)) {
                emit(.punctuation, i, i + 1); i += 1; continue
            }
            var len = 1
            for op in Self.operators where i + op.count <= n && s[i..<i + op.count].elementsEqual(op) { len = op.count; break }
            emit(.operator, i, i + len); i += len
        }
        return tokens
    }

    private func hexValue(_ c: UInt16) -> Int? {
        switch c {
        case 48...57: return Int(c) - 48
        case 65...70: return Int(c) - 55
        case 97...102: return Int(c) - 87
        default: return nil
        }
    }

    public func completionContext(text s: [UInt16], tokens: [Token], cursor: Int, explicit: Bool) -> CompletionContext? {
        typealias C = UTF16Char
        guard cursor >= 0, cursor <= s.count else { return nil }
        if let t = tokens.token(around: cursor), t.location < cursor {
            switch t.kind {
            case .comment:
                // a line comment runs to the end of the line; a block comment until it is closed
                let closed = t.length >= 4 && s[t.end - 1] == C.slash && s[t.end - 2] == C.star && s[t.location + 1] == C.star
                if cursor < t.end || !closed { return nil }
            case .string:
                let first = s[t.location], last = s[t.end - 1]
                let closed = first == C.quote || first == C.apostrophe
                    ? t.length >= 2 && last == first
                    : last == C.backtick && (t.length >= 2 || first != C.backtick) // a template piece
                if cursor < t.end || !closed { return nil }
            case .regex: if cursor < t.end { return nil }
            case .number: return nil
            default: break
            }
        }
        var start = cursor
        while start > 0 && C.isIdentifierPart(s[start - 1]) { start -= 1 }
        if start < cursor && C.isDigit(s[start]) { return nil }
        let prefix = s.string(NSRange(location: start, length: cursor - start))
        let range = NSRange(location: start, length: cursor - start)
        // what precedes the word
        guard let pi = tokens.lastIndex(startingBefore: start) else {
            return prefix.isEmpty && !explicit ? nil : CompletionContext(kind: .global, prefix: prefix, range: range, explicit: explicit)
        }
        var before = tokens[pi]
        if before.end > start, pi > 0 { before = tokens[pi - 1] } // the word itself was tokenized
        let beforeText = s.string(before.range)
        if before.kind == .punctuation && (beforeText == "." || beforeText == "?.") {
            var receiver: String? = nil
            if let ri = tokens.lastIndex(startingBefore: before.location) {
                let r = tokens[ri]
                if r.kind == .number { return nil }
                if [.identifier, .definition, .constant, .property, .keyword].contains(r.kind) { receiver = s.string(r.range) }
            }
            return CompletionContext(kind: .member(receiver: receiver), prefix: prefix, range: range, explicit: explicit)
        }
        if before.kind == .keyword && (beforeText == "let" || beforeText == "const" || beforeText == "function") { return nil }
        if before.kind == .number && before.end == start { return nil }
        if prefix.isEmpty && !explicit { return nil }
        return CompletionContext(kind: .global, prefix: prefix, range: range, explicit: explicit)
    }

    public func languageCompletions(text s: [UInt16], tokens: [Token]) -> [Completion] {
        var names: [String: Completion.Kind] = [:]
        func add(_ t: Token, _ kind: Completion.Kind) { names[s.string(t.range)] = names[s.string(t.range)] ?? kind }
        /// Identifiers that are parameters in the brackets ending at index `close` (a `)` token).
        func parameters(endingAt close: Int) {
            var depth = 0, k = close
            while k >= 0 {
                let t = tokens[k]
                if t.kind == .bracket {
                    let c = s[t.location]
                    if UTF16Char.isCloser(c) { depth += 1 } else { depth -= 1; if depth == 0 { break } }
                } else if depth >= 1, t.kind == .identifier || t.kind == .definition || t.kind == .property, k > 0 {
                    // a parameter, also inside a destructuring pattern ({ depth }, { a: b } binds b)
                    let pt = s.string(tokens[k - 1].range)
                    let nt = k + 1 < tokens.count ? s.string(tokens[k + 1].range) : ""
                    if ["(", ",", "{", "[", "...", ":"].contains(pt) && nt != ":" { add(t, .variable) }
                }
                k -= 1
            }
        }
        for (k, t) in tokens.enumerated() {
            switch t.kind {
            case .definition:
                let isFunction = k > 0 && s.string(tokens[k - 1].range) == "function"
                add(t, isFunction ? .function : .variable)
                if isFunction, k + 1 < tokens.count, s.string(tokens[k + 1].range) == "(" {
                    var depth = 0, j = k + 1
                    while j < tokens.count {
                        if tokens[j].kind == .bracket {
                            let c = s[tokens[j].location]
                            if UTF16Char.isOpener(c) { depth += 1 } else { depth -= 1; if depth == 0 { parameters(endingAt: j); break } }
                        }
                        j += 1
                    }
                }
            case .operator where s.string(t.range) == "=>" && k > 0:
                let p = tokens[k - 1]
                if p.kind == .identifier { add(p, .variable) }
                else if p.kind == .bracket && s[p.location] == UTF16Char.rparen { parameters(endingAt: k - 1) }
            case .bracket where s[t.location] == UTF16Char.lbrace || s[t.location] == UTF16Char.lbracket:
                // destructuring: const { a, b } = … and const [a, b] = …
                if k > 0, tokens[k - 1].kind == .keyword, ["let", "const"].contains(s.string(tokens[k - 1].range)) {
                    var depth = 0, j = k
                    while j < tokens.count {
                        let u = tokens[j]
                        if u.kind == .bracket { if UTF16Char.isOpener(s[u.location]) { depth += 1 } else { depth -= 1; if depth == 0 { break } } }
                        else if u.kind == .identifier || u.kind == .property, j + 1 < tokens.count, s.string(tokens[j + 1].range) != ":" { add(u, .variable) }
                        j += 1
                    }
                }
            default: break
            }
        }
        var out = names.map { Completion(label: $0.key, kind: $0.value) }
        out += Self.keywords.subtracting(["as", "from", "of", "in"]).map { Completion(label: $0, kind: .keyword, boost: -1) }
        out += Self.constants.map { Completion(label: $0, kind: .constant, boost: -1) }
        return out
    }
}
