import Foundation

/// A language the editor can edit: how to split source into tokens and where completion applies.
public protocol CodeLanguage {
    /// Tokens of the whole text, in order, not overlapping; whitespace is left out.
    func tokenize(_ text: [UInt16]) -> [Token]
    /// The line comment marker toggled by Command-/ ("//"), or nil.
    var lineComment: String? { get }
    /// The completion context at the cursor, or nil where completion does not apply (in a string, a
    /// comment, a number, a name being declared).
    func completionContext(text: [UInt16], tokens: [Token], cursor: Int, explicit: Bool) -> CompletionContext?
    /// Entries the language itself offers for a name on its own: keywords and the names the document
    /// declares.
    func languageCompletions(text: [UInt16], tokens: [Token]) -> [Completion]
}
