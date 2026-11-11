#if canImport(UIKit)
import UIKit

/// The editor on iOS: a UITextView on TextKit 1 with a line-number gutter, the current line, completion
/// and diagnostic popups and a row of code symbols above the keyboard.
final class CodeTextView: UITextView, EditorHost, UITextViewDelegate, NSTextStorageDelegate {
    let engine: EditorEngine
    weak var document: CodeDocument?
    private let gutter = GutterView()
    private let lineHighlight = UIView()
    private let completionView = PopupView()
    private let bubbleView = PopupView()
    private var gutterWidth: CGFloat = 0
    private var visualKey = ""
    private var symbolBar: UIView?

    init(document: CodeDocument, configuration: EditorConfiguration) {
        engine = EditorEngine(configuration: configuration)
        self.document = document
        let storage = NSTextStorage(string: document.text)
        let lm = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        lm.addTextContainer(container)
        storage.addLayoutManager(lm)
        super.init(frame: .zero, textContainer: container)
        storage.delegate = self
        delegate = self
        engine.host = self
        engine.onTextChange = { [weak document] s in document?.textChanged(s) }
        engine.onSelectionChange = { [weak document] r in document?.selectionChanged(r) }

        autocorrectionType = .no
        autocapitalizationType = .none
        spellCheckingType = .no
        smartQuotesType = .no
        smartDashesType = .no
        smartInsertDeleteType = .no
        inlinePredictionType = .no
        dataDetectorTypes = []
        allowsEditingTextAttributes = false
        isFindInteractionEnabled = true
        alwaysBounceVertical = true
        keyboardDismissMode = .interactive
        layoutManager.allowsNonContiguousLayout = false

        lineHighlight.isUserInteractionEnabled = false
        insertSubview(lineHighlight, at: 0)
        gutter.textView = self
        addSubview(gutter)
        gutter.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(gutterTapped(_:))))
        for p in [completionView, bubbleView] { p.isHidden = true; addSubview(p) }
        completionView.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(completionTapped(_:))))
        completionView.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(completionPanned(_:))))
        bubbleView.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(bubbleTapped)))
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (v: CodeTextView, _) in v.redrawAll() }

        apply(configuration)
        engine.setDiagnostics(document.diagnostics)
        engine.setChecked(document.checkedDiagnostics)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    private var theme: EditorTheme { engine.theme }

    func apply(_ c: EditorConfiguration) {
        engine.configuration = c
        guard c.visualKey != visualKey else { return }
        visualKey = c.visualKey
        isEditable = c.isEditable
        backgroundColor = c.theme.background
        font = c.theme.font
        gutter.isHidden = !c.showsLineNumbers
        lineHighlight.backgroundColor = c.theme.currentLine
        inputAccessoryView = c.showsSymbolBar && c.isEditable ? makeSymbolBar() : nil
        engine.reload()
        updateInsets()
        setNeedsLayout()
    }

    // MARK: EditorHost

    var storage: NSTextStorage { textStorage }
    var selection: NSRange {
        get { selectedRange }
        set { selectedRange = newValue }
    }
    var hasMarkedText: Bool { markedTextRange != nil }

    func perform(_ edit: TextEdit) {
        guard let a = position(from: beginningOfDocument, offset: edit.range.location),
              let b = position(from: a, offset: edit.range.length),
              let r = textRange(from: a, to: b) else { return }
        replace(r, withText: edit.text)
        selectedRange = edit.selection
        scrollRangeToVisible(edit.selection)
    }

    func popupsChanged() { layoutPopups() }

    func decorationsChanged() {
        updateInsets()
        gutter.setNeedsDisplay()
        updateLineHighlight()
    }

    func resetTypingAttributes() { typingAttributes = engine.highlighter.baseAttributes(theme) }

    override var undoManager: UndoManager? { document?.undoManager }

    // MARK: Delegates

    func textStorage(_ textStorage: NSTextStorage, didProcessEditing editedMask: NSTextStorage.EditActions, range editedRange: NSRange, changeInLength delta: Int) {
        if editedMask.contains(.editedCharacters) { engine.storageEdited(range: editedRange, delta: delta) }
    }

    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        if markedTextRange != nil { return true }
        let sel = selectedRange
        if range == sel { return text.isEmpty ? true : !engine.insertText(text) }
        if text.isEmpty, sel.length == 0, range.length == 1, range.end == sel.location { return !engine.deleteBackward() }
        return true
    }

    func textViewDidChange(_ textView: UITextView) { engine.flush() }

    // The keyboard's entry points: the rules apply however text arrives (the keyboard, a hardware
    // keyboard, the symbol bar). When the engine leaves it, UIKit inserts and asks the delegate above,
    // which comes to the same answer.
    override func insertText(_ text: String) {
        if markedTextRange == nil, engine.insertText(text) { return }
        super.insertText(text)
    }

    override func deleteBackward() {
        if markedTextRange == nil, engine.deleteBackward() { return }
        super.deleteBackward()
    }

    func textViewDidChangeSelection(_ textView: UITextView) { engine.selectionDidChange() }

    // MARK: Layout and drawing

    override func layoutSubviews() {
        super.layoutSubviews()
        gutter.frame = CGRect(x: contentOffset.x, y: contentOffset.y, width: gutterWidth, height: bounds.height)
        gutter.setNeedsDisplay()
        bringSubviewToFront(gutter)
        bringSubviewToFront(bubbleView)
        bringSubviewToFront(completionView)
        updateLineHighlight()
    }

    private func updateInsets() {
        let w = engine.configuration.showsLineNumbers ? GutterRenderer.width(lineCount: engine.lines.count, theme: theme) : 0
        if w != gutterWidth || textContainerInset.top != 8 {
            gutterWidth = w
            textContainerInset = UIEdgeInsets(top: 8, left: w + 6, bottom: 8, right: 8)
            setNeedsLayout()
        }
    }

    private func redrawAll() {
        gutter.setNeedsDisplay()
        completionView.setNeedsDisplay()
        bubbleView.setNeedsDisplay()
    }

    func drawGutter(size: CGSize) {
        let inset = textContainerInset
        let visible = CGRect(x: 0, y: contentOffset.y - inset.top, width: textContainer.size.width, height: bounds.height)
        let sev = engine.lineSeverities, cur = engine.currentLine
        let lines = GutterRenderer.visibleLines(layoutManager: layoutManager, container: textContainer, lines: engine.lines, rect: visible).map {
            GutterLine(number: $0.line + 1, y: $0.rect.minY + inset.top - contentOffset.y, height: $0.rect.height, current: $0.line == cur, severity: sev[$0.line])
        }
        GutterRenderer.draw(lines, size: size, theme: theme)
    }

    /// The rectangle of a whole line (all its wrapped fragments) in text view coordinates.
    private func lineRect(_ line: Int) -> CGRect? {
        let start = engine.lines.start(ofLine: line)
        let lm = layoutManager
        var r: CGRect
        if start >= textStorage.length {
            r = lm.extraLineFragmentRect
            if r.isEmpty {
                guard textStorage.length > 0 else { return nil }
                r = lm.lineFragmentRect(forGlyphAt: lm.glyphIndexForCharacter(at: textStorage.length - 1), effectiveRange: nil)
            }
        } else {
            let range = engine.lines.range(ofLine: line, in: engine.units)
            let g0 = lm.glyphIndexForCharacter(at: range.location)
            r = lm.lineFragmentRect(forGlyphAt: g0, effectiveRange: nil)
            if range.length > 0 {
                let g1 = lm.glyphIndexForCharacter(at: range.end - 1)
                r = r.union(lm.lineFragmentRect(forGlyphAt: g1, effectiveRange: nil))
            }
        }
        return r.offsetBy(dx: textContainerInset.left, dy: textContainerInset.top)
    }

    private func updateLineHighlight() {
        let sel = selectedRange
        guard engine.configuration.highlightsCurrentLine,
              engine.lines.line(containing: sel.location) == engine.lines.line(containing: sel.end),
              let r = lineRect(engine.currentLine) else { lineHighlight.isHidden = true; return }
        lineHighlight.isHidden = false
        lineHighlight.frame = CGRect(x: 0, y: r.minY, width: max(bounds.width, contentSize.width), height: r.height)
    }

    private var visibleArea: CGRect {
        CGRect(x: contentOffset.x, y: contentOffset.y + adjustedContentInset.top,
               width: bounds.width, height: bounds.height - adjustedContentInset.top - adjustedContentInset.bottom)
    }

    private func layoutPopups() {
        let area = visibleArea
        if let list = engine.completion, let end = selectedTextRange?.end {
            let caret = caretRect(for: end)
            let size = list.size(theme, maxWidth: area.width - 8)
            let prefixWidth = (list.context.prefix as NSString).size(withAttributes: [.font: theme.font]).width
            var x = caret.minX - prefixWidth - 26
            x = max(area.minX + 4, min(x, area.maxX - size.width - 4))
            var y = caret.maxY + 2
            if y + size.height > area.maxY, caret.minY - 2 - size.height >= area.minY { y = caret.minY - 2 - size.height }
            completionView.frame = CGRect(x: x, y: y, width: size.width, height: size.height)
            completionView.drawer = { [weak self] s in self.map { list.draw(size: s, theme: $0.theme) } }
            completionView.isHidden = false
            completionView.setNeedsDisplay()
        } else {
            completionView.isHidden = true
        }
        if let b = engine.bubble, let r = lineRect(b.line) {
            let size = b.bubble.size(theme, maxWidth: area.width - gutterWidth - 16)
            let x = max(area.minX + gutterWidth + 4, min(textContainerInset.left, area.maxX - size.width - 4))
            bubbleView.frame = CGRect(x: x, y: r.maxY + 2, width: size.width, height: size.height)
            bubbleView.drawer = { [weak self] s in self.map { b.bubble.draw(size: s, theme: $0.theme) } }
            bubbleView.isHidden = false
            bubbleView.setNeedsDisplay()
        } else {
            bubbleView.isHidden = true
        }
    }

    // MARK: Gestures

    @objc private func gutterTapped(_ g: UITapGestureRecognizer) {
        let y = g.location(in: self).y - textContainerInset.top
        let line = engine.lines.line(containing: layoutManager.characterIndex(for: CGPoint(x: 1, y: y), in: textContainer, fractionOfDistanceBetweenInsertionPoints: nil))
        let lineAtY = (y > layoutManager.usedRect(for: textContainer).maxY) ? engine.lines.count - 1 : line
        engine.toggleBubble(line: lineAtY)
    }

    @objc private func completionTapped(_ g: UITapGestureRecognizer) {
        guard let list = engine.completion, let row = list.row(at: g.location(in: completionView).y, theme) else { return }
        engine.selectCompletion(row)
        engine.acceptCompletion()
    }

    private var panStart = 0
    @objc private func completionPanned(_ g: UIPanGestureRecognizer) {
        guard let list = engine.completion else { return }
        if g.state == .began { panStart = list.top }
        let rows = Int(-g.translation(in: completionView).y / list.rowHeight(theme))
        engine.scrollCompletion(by: panStart + rows - list.top)
    }

    @objc private func bubbleTapped() { _ = engine.cancel() }

    // MARK: Keys

    override var keyCommands: [UIKeyCommand]? {
        var list = [
            UIKeyCommand(title: "Toggle Comment", action: #selector(toggleCommentCommand), input: "/", modifierFlags: .command),
            UIKeyCommand(title: "Indent", action: #selector(indentCommand), input: "]", modifierFlags: .command),
            UIKeyCommand(title: "Outdent", action: #selector(outdentCommand), input: "[", modifierFlags: .command),
            UIKeyCommand(title: "Complete", action: #selector(completeCommand), input: " ", modifierFlags: .control),
            UIKeyCommand(input: "\t", modifierFlags: .shift, action: #selector(backtabCommand)),
        ]
        if engine.completion != nil {
            for (input, action) in [(UIKeyCommand.inputUpArrow, #selector(upCommand)), (UIKeyCommand.inputDownArrow, #selector(downCommand))] {
                let k = UIKeyCommand(input: input, modifierFlags: [], action: action)
                k.wantsPriorityOverSystemBehavior = true
                list.append(k)
            }
        }
        if engine.completion != nil || engine.bubble != nil {
            let k = UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(escapeCommand))
            k.wantsPriorityOverSystemBehavior = true
            list.append(k)
        }
        return list
    }

    @objc private func toggleCommentCommand() { engine.toggleComment() }
    @objc private func indentCommand() { engine.indent(outdent: false) }
    @objc private func outdentCommand() { engine.indent(outdent: true) }
    @objc private func completeCommand() { engine.triggerCompletion() }
    @objc private func backtabCommand() { _ = engine.insertBacktab() }
    @objc private func upCommand() { _ = engine.moveCompletion(by: -1) }
    @objc private func downCommand() { _ = engine.moveCompletion(by: 1) }
    @objc private func escapeCommand() { _ = engine.cancel() }

    // MARK: Symbol bar

    private func makeSymbolBar() -> UIView {
        let bar = UIInputView(frame: CGRect(x: 0, y: 0, width: 320, height: 44), inputViewStyle: .keyboard)
        bar.allowsSelfSizing = true
        let scroll = UIScrollView()
        scroll.showsHorizontalScrollIndicator = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        let stack = UIStackView()
        stack.axis = .horizontal
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        func button(_ title: String?, image: String? = nil, _ action: @escaping () -> Void) -> UIButton {
            var cfg = UIButton.Configuration.filled()
            cfg.baseBackgroundColor = .secondarySystemBackground
            cfg.baseForegroundColor = .label
            cfg.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 11, bottom: 6, trailing: 11)
            if let title {
                cfg.attributedTitle = AttributedString(title, attributes: AttributeContainer([.font: UIFont.monospacedSystemFont(ofSize: 17, weight: .medium)]))
            }
            if let image { cfg.image = UIImage(systemName: image) }
            let b = UIButton(configuration: cfg, primaryAction: UIAction { _ in action() })
            return b
        }
        stack.addArrangedSubview(button(nil, image: "arrow.right.to.line") { [weak self] in _ = self?.engine.insertTab() })
        for sym in ["(", ")", "{", "}", "[", "]", ".", ",", ";", "=", "'", "`", "+", "-", "*", "/", "<", ">", "!", "&", "|", ":", "?"] {
            stack.addArrangedSubview(button(sym) { [weak self] in self?.typeSymbol(sym) })
        }
        stack.addArrangedSubview(button(nil, image: "arrow.uturn.backward") { [weak self] in self?.undoManager?.undo() })
        stack.addArrangedSubview(button(nil, image: "arrow.uturn.forward") { [weak self] in self?.undoManager?.redo() })
        let hide = button(nil, image: "keyboard.chevron.compact.down") { [weak self] in _ = self?.resignFirstResponder() }
        hide.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        bar.addSubview(scroll)
        bar.addSubview(hide)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 6),
            scroll.trailingAnchor.constraint(equalTo: hide.leadingAnchor, constant: -6),
            scroll.topAnchor.constraint(equalTo: bar.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bar.bottomAnchor),
            hide.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -6),
            hide.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: scroll.frameLayoutGuide.centerYAnchor),
            stack.heightAnchor.constraint(equalToConstant: 34),
        ])
        symbolBar = bar
        return bar
    }

    private func typeSymbol(_ s: String) { insertText(s) }

    // MARK: Commands from the document

    func reveal(line: Int, column: Int?) {
        let l = max(0, min(line - 1, engine.lines.count - 1))
        let r = engine.lines.range(ofLine: l, in: engine.units)
        let loc = column.map { r.location + max(0, min($0 - 1, r.length)) } ?? r.location
        selectedRange = NSRange(location: loc, length: 0)
        scrollRangeToVisible(selectedRange)
    }

    func showFind(replace: Bool) { findInteraction?.presentFindNavigator(showingReplace: replace) }

    func focus() { becomeFirstResponder() }
}

/// The line-number gutter, pinned to the left of the text view.
final class GutterView: UIView {
    weak var textView: CodeTextView?
    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = true
        contentMode = .redraw
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ rect: CGRect) { textView?.drawGutter(size: bounds.size) }
}

/// A view that draws with a closure: the completion list, the diagnostic bubble.
final class PopupView: UIView {
    var drawer: ((CGSize) -> Void)?
    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.15
        layer.shadowRadius = 8
        layer.shadowOffset = CGSize(width: 0, height: 3)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ rect: CGRect) { drawer?(bounds.size) }
}
#endif
