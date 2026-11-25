import Foundation

/// A message about the source at a line: a build error, a warning.
public struct Diagnostic: Hashable, Sendable {
    public enum Severity: Int, Hashable, Sendable, Comparable {
        case info, warning, error
        public static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }
    }

    /// 1-based line.
    public var line: Int
    /// 1-based column in UTF-16 units; nil marks the whole line.
    public var column: Int?
    /// How many units to underline from the column; nil underlines the token there.
    public var length: Int?
    public var severity: Severity
    public var message: String

    public init(line: Int, column: Int? = nil, length: Int? = nil, severity: Severity = .error, message: String) {
        self.line = line
        self.column = column
        self.length = length
        self.severity = severity
        self.message = message
    }
}
