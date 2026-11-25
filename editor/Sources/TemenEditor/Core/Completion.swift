import Foundation

/// One completion entry.
public struct Completion: Hashable, Sendable {
    public enum Kind: Hashable, Sendable { case function, method, variable, constant, keyword, property, snippet, text }

    /// What is shown and matched against what was typed.
    public var label: String
    /// A short signature shown beside the label: "(w, h, d)".
    public var detail: String?
    /// A sentence shown under the list for the selected entry.
    public var info: String?
    public var kind: Kind
    /// Text to insert with fields: `box(${w}, ${h}, ${d})`; Tab moves through them. Nil inserts the label.
    public var snippet: String?
    /// Ranks entries that match equally well; higher first.
    public var boost: Int

    public init(label: String, detail: String? = nil, info: String? = nil, kind: Kind = .text, snippet: String? = nil, boost: Int = 0) {
        self.label = label
        self.detail = detail
        self.info = info
        self.kind = kind
        self.snippet = snippet
        self.boost = boost
    }
}

/// Where completion was asked for: the word being typed and what it follows.
public struct CompletionContext: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// A name on its own.
        case global
        /// A name after a dot; the receiver is the identifier before the dot, when there is one.
        case member(receiver: String?)
    }

    public var kind: Kind
    /// The part of the word before the cursor.
    public var prefix: String
    /// The range the chosen entry replaces: the start of the word to the cursor.
    public var range: NSRange
    /// True when the user asked (Control-Space, Escape) rather than typed.
    public var explicit: Bool

    public init(kind: Kind, prefix: String, range: NSRange, explicit: Bool) {
        self.kind = kind
        self.prefix = prefix
        self.range = range
        self.explicit = explicit
    }
}

/// Supplies completion entries; the editor filters and ranks them against the prefix.
public protocol CompletionSource {
    func completions(for context: CompletionContext) -> [Completion]
}

/// A fixed list: names offered on their own, and members offered after a dot.
public struct StaticCompletions: CompletionSource {
    public var globals: [Completion]
    public var members: [Completion]
    /// Receivers whose members are not these (`Math.`, `JSON.`).
    public var excludedReceivers: Set<String>

    public init(globals: [Completion], members: [Completion],
                excludedReceivers: Set<String> = ["Math", "JSON", "console", "Object", "Array", "Number", "String"]) {
        self.globals = globals
        self.members = members
        self.excludedReceivers = excludedReceivers
    }

    public func completions(for context: CompletionContext) -> [Completion] {
        switch context.kind {
        case .global: return globals
        case .member(let receiver):
            if let r = receiver, excludedReceivers.contains(r) { return [] }
            return members
        }
    }
}

/// Fuzzy matching of a typed prefix against a label, with the matched positions for highlighting.
public enum CompletionMatcher {
    public struct Match: Equatable { public var score: Int; public var positions: [Int] }

    public static func match(_ label: String, _ prefix: String) -> Match? {
        let p = Array(prefix.utf16), l = Array(label.utf16)
        if p.isEmpty { return Match(score: 0, positions: []) }
        if p.count > l.count { return nil }
        let lower = { (c: UInt16) -> UInt16 in (c >= 65 && c <= 90) ? c + 32 : c }
        if l.starts(with: p) { return Match(score: 1000 - l.count, positions: Array(0..<p.count)) }
        let pl = p.map(lower), ll = l.map(lower)
        if ll.starts(with: pl) { return Match(score: 800 - l.count, positions: Array(0..<p.count)) }
        // word starts: the first letter, a capital after a lower-case letter, a letter after _ or a digit
        let starts = l.indices.filter { i in
            i == 0 || (l[i] >= 65 && l[i] <= 90 && !(l[i - 1] >= 65 && l[i - 1] <= 90))
                || (l[i - 1] == 95 && l[i] != 95) || (UTF16Char.isDigit(l[i - 1]) && !UTF16Char.isDigit(l[i]))
        }
        if pl[0] == ll[0] {
            var pos: [Int] = [], k = 0
            for i in starts where k < pl.count && ll[i] == pl[k] { pos.append(i); k += 1 }
            if k == pl.count { return Match(score: 600 - l.count, positions: pos) }
        }
        if let r = find(pl, in: ll) { return Match(score: 400 - r - l.count, positions: Array(r..<r + p.count)) }
        var pos: [Int] = [], k = 0
        for i in ll.indices where k < pl.count && ll[i] == pl[k] { pos.append(i); k += 1 }
        guard k == pl.count, let first = pos.first, let last = pos.last else { return nil }
        return Match(score: 200 - (last - first - pl.count) - first - l.count, positions: pos)
    }

    private static func find(_ needle: [UInt16], in hay: [UInt16]) -> Int? {
        guard needle.count <= hay.count else { return nil }
        for i in 0...(hay.count - needle.count) where hay[i..<i + needle.count].elementsEqual(needle) { return i }
        return nil
    }

    /// Entries matching the prefix, best first.
    public static func rank(_ items: [Completion], prefix: String) -> [(Completion, Match)] {
        var seen = Set<String>()
        var out: [(Completion, Match)] = []
        for c in items where !seen.contains(c.label) {
            seen.insert(c.label)
            if let m = match(c.label, prefix) { out.append((c, m)) }
        }
        out.sort { a, b in
            if a.1.score != b.1.score { return a.1.score > b.1.score }
            if a.0.boost != b.0.boost { return a.0.boost > b.0.boost }
            return a.0.label < b.0.label
        }
        return out
    }
}
