import Foundation
import Combine

/// One file's text in an editor, with its own undo history, selection and diagnostics. Keep one per
/// file and hand it to `CodeEditor`; switching documents keeps each file's undo and scroll position.
@MainActor
public final class CodeDocument: ObservableObject, Identifiable {
    public let id = UUID()
    /// The text as edited; updated on every change.
    @Published public private(set) var text: String
    /// Messages shown in the gutter and underlined in the text. They follow edits until replaced.
    @Published public var diagnostics: [Diagnostic] = [] {
        didSet { view?.engine.setDiagnostics(diagnostics) }
    }
    /// Checks the text as it is typed, such as a syntax check: it runs a moment after each pause in typing
    /// (`checkDelay`) and when set, and its messages show with `diagnostics`. While it reports an error,
    /// the errors in `diagnostics` are hidden (they belong to text that has changed since); warnings stay.
    /// A result that arrives after the text changed again is dropped.
    public var checker: (@Sendable (String) async -> [Diagnostic])? {
        didSet { scheduleCheck(delay: 0) }
    }
    /// Seconds after the last edit before the checker runs.
    public var checkDelay: TimeInterval = 0.35
    /// The checker's messages for the current text.
    @Published public private(set) var checkedDiagnostics: [Diagnostic] = []
    private var checkTask: Task<Void, Never>?

    @Published public private(set) var selectedRange = NSRange(location: 0, length: 0)
    public let undoManager = UndoManager()

    var view: CodeTextView?

    public init(text: String = "") {
        self.text = text
    }

    /// Replaces the text (another program changed the file): as one undoable change, or as a fresh
    /// start that also clears the undo history.
    public func replaceText(_ newText: String, undoable: Bool = true) {
        guard newText != text else { return }
        if let view {
            view.engine.setText(newText, undoable: undoable)
        } else {
            text = newText
            scheduleCheck(delay: 0)
        }
        if !undoable { undoManager.removeAllActions() }
    }

    /// Selects a line (1-based), or a column on it, and scrolls to it.
    public func reveal(line: Int, column: Int? = nil) {
        view?.reveal(line: line, column: column)
    }

    /// Opens the system find bar (with replace).
    public func showFind(replace: Bool = false) {
        view?.showFind(replace: replace)
    }

    /// Puts the keyboard focus in the editor.
    public func focus() {
        view?.focus()
    }

    /// Opens completion at the cursor.
    public func complete() {
        view?.engine.triggerCompletion()
    }

    /// Comments or uncomments the selected lines.
    public func toggleComment() {
        view?.engine.toggleComment()
    }

    /// Indents or outdents the selected lines.
    public func indent(outdent: Bool = false) {
        view?.engine.indent(outdent: outdent)
    }

    func textChanged(_ s: String) {
        if text != s { text = s; scheduleCheck(delay: checkDelay) }
    }

    private func scheduleCheck(delay: TimeInterval) {
        checkTask?.cancel()
        guard let checker else {
            checkTask = nil
            setChecked([])
            return
        }
        let snapshot = text
        checkTask = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            if Task.isCancelled { return }
            let found = await checker(snapshot)
            guard let self, !Task.isCancelled, self.text == snapshot else { return }
            self.setChecked(found)
        }
    }

    private func setChecked(_ list: [Diagnostic]) {
        if checkedDiagnostics != list { checkedDiagnostics = list }
        view?.engine.setChecked(list)
    }

    func selectionChanged(_ r: NSRange) {
        if selectedRange != r { selectedRange = r }
    }

    func editorView(_ configuration: EditorConfiguration) -> CodeTextView {
        if let view { view.apply(configuration); return view }
        let v = CodeTextView(document: self, configuration: configuration)
        view = v
        return v
    }
}
