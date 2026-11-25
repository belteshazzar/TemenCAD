import Foundation

/// What a run of source text is, for colouring and for the editing rules.
public enum TokenKind: Hashable, Sendable, CaseIterable {
    case keyword
    /// A word the language reserves but does not support (`var`, `class` in the JavaScript subset).
    case invalid
    case constant
    case identifier
    /// A name being declared (`let size`, `function bracket`).
    case definition
    /// A name that is called (`box(`, `.translate(`).
    case function
    /// A name after a dot.
    case property
    case number
    case string
    case regex
    case comment
    case `operator`
    case punctuation
    /// `(` `)` `[` `]` `{` `}`, and `${` opening a template substitution.
    case bracket
}

/// A token: a kind and a range in UTF-16 code units.
public struct Token: Equatable, Sendable {
    public var kind: TokenKind
    public var location: Int
    public var length: Int

    public init(_ kind: TokenKind, _ location: Int, _ length: Int) {
        self.kind = kind
        self.location = location
        self.length = length
    }

    public var end: Int { location + length }
    public var range: NSRange { NSRange(location: location, length: length) }
}

extension Array where Element == Token {
    /// Index of the last token starting before `position`, by binary search.
    func lastIndex(startingBefore position: Int) -> Int? {
        var lo = 0, hi = count
        while lo < hi {
            let mid = (lo + hi) / 2
            if self[mid].location < position { lo = mid + 1 } else { hi = mid }
        }
        return lo == 0 ? nil : lo - 1
    }

    /// The token with `position` strictly inside it or at its end.
    func token(around position: Int) -> Token? {
        guard let i = lastIndex(startingBefore: position) else { return nil }
        return self[i].end >= position ? self[i] : nil
    }
}
