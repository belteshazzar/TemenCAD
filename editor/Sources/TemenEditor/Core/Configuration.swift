import Foundation

/// How an editor looks and behaves. The app sets the language, the completion entries and the theme.
public struct EditorConfiguration {
    public var language: CodeLanguage
    public var theme: EditorTheme
    /// The entries offered while typing, filtered and ranked by the editor; the language adds its keywords
    /// and the names the document declares.
    public var completions: CompletionSource?
    public var editing: EditingRules.Options
    public var showsLineNumbers: Bool
    public var highlightsCurrentLine: Bool
    public var isEditable: Bool
    /// Wrap long lines (macOS; iOS always wraps).
    public var wrapsLines: Bool
    /// A row of code symbols above the software keyboard (iOS).
    public var showsSymbolBar: Bool

    public init(language: CodeLanguage = JavaScriptSubset(), theme: EditorTheme = .standard, completions: CompletionSource? = nil,
                editing: EditingRules.Options = .init(), showsLineNumbers: Bool = true, highlightsCurrentLine: Bool = true,
                isEditable: Bool = true, wrapsLines: Bool = false, showsSymbolBar: Bool = true) {
        self.language = language
        self.theme = theme
        self.completions = completions
        self.editing = editing
        self.showsLineNumbers = showsLineNumbers
        self.highlightsCurrentLine = highlightsCurrentLine
        self.isEditable = isEditable
        self.wrapsLines = wrapsLines
        self.showsSymbolBar = showsSymbolBar
    }

    /// What, when it changes, needs the text coloured and laid out again.
    var visualKey: String {
        "\(theme.name)|\(theme.font.fontName)|\(theme.font.pointSize)|\(showsLineNumbers)|\(highlightsCurrentLine)|\(isEditable)|\(wrapsLines)|\(showsSymbolBar)|\(type(of: language))"
    }
}
