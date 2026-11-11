#if canImport(AppKit) && !canImport(UIKit)
import AppKit

/// The editor on macOS: an NSTextView on TextKit 1 in a scroll view, with a line-number ruler, the
/// current line, completion and diagnostic popups and the find bar.
final class CodeTextView: NSTextView, EditorHost, NSTextViewDelegate, NSTextStorageDelegate {
    let engine: EditorEngine
    weak var document: CodeDocument?
    let scroll = NSScrollView()
    private var ruler: GutterRulerView!
    private let completionView = PopupView()
    private let bubbleView = PopupView()
    private var visualKey = ""
    private var lastLineRect: NSRect = .zero

    init(document: CodeDocument, configuration: EditorConfiguration) {
        engine = EditorEngine(configuration: configuration)
        self.document = document
        let storage = NSTextStorage(string: document.text)
        let lm = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        lm.addTextContainer(container)
        storage.addLayoutManager(lm)
        super.init(frame: NSRect(x: 0, y: 0, width: 400, height: 400), textContainer: container)
        storage.delegate = self
        delegate = self
        engine.host = self
        engine.onTextChange = { [weak document] s in document?.textChanged(s) }
        engine.onSelectionChange = { [weak document] r in document?.selectionChanged(r) }

        isRichText = false
        importsGraphics = false
        allowsUndo = true
        usesFindBar = true
        isIncrementalSearchingEnabled = true
        isAutomaticQuoteSubstitutionEnabled = false
        isAutomaticDashSubstitutionEnabled = false
        isAutomaticTextReplacementEnabled = false
        isAutomaticSpellingCorrectionEnabled = false
        isContinuousSpellCheckingEnabled = false
        isGrammarCheckingEnabled = false
        isAutomaticLinkDetectionEnabled = false
        isAutomaticDataDetectionEnabled = false
        isAutomaticTextCompletionEnabled = false
        smartInsertDeleteEnabled = false
        layoutManager?.allowsNonContiguousLayout = false
        isVerticallyResizable = true
        minSize = .zero
        maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        autoresizingMask = [.width]
        textContainerInset = NSSize(width: 4, height: 8)

        scroll.documentView = self
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = true
        scroll.contentView.postsBoundsChangedNotifications = true
        ruler = GutterRulerView(textView: self)
        scroll.verticalRulerView = ruler
        scroll.hasVerticalRuler = true
        NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: scroll.contentView)

        for p in [completionView, bubbleView] { p.isHidden = true; addSubview(p) }
        completionView.onClick = { [weak self] p in self?.completionClicked(p) }
        completionView.onScroll = { [weak self] rows in self?.engine.scrollCompletion(by: rows) }
        bubbleView.onClick = { [weak self] _ in _ = self?.engine.cancel() }

        apply(configuration)
        engine.setDiagnostics(document.diagnostics)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    private var theme: EditorTheme { engine.theme }

    func apply(_ c: EditorConfiguration) {
        engine.configuration = c
        guard c.visualKey != visualKey else { return }
        visualKey = c.visualKey
        isEditable = c.isEditable
        backgroundColor = c.theme.background
        scroll.backgroundColor = c.theme.background
        font = c.theme.font
        scroll.rulersVisible = c.showsLineNumbers
        if c.wrapsLines {
            textContainer?.widthTracksTextView = true
            isHorizontallyResizable = false
            scroll.hasHorizontalScroller = false
            textContainer?.containerSize = NSSize(width: scroll.contentSize.width, height: CGFloat.greatestFiniteMagnitude)
            autoresizingMask = [.width]
        } else {
            textContainer?.widthTracksTextView = false
            textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
            isHorizontallyResizable = true
            scroll.hasHorizontalScroller = true
            autoresizingMask = [.width, .height]
        }
        engine.reload()
        ruler.updateThickness()
        scroll.tile()
        alignToInsets()
        needsDisplay = true
    }

    /// The scroll view floats the ruler over the text and insets the clip view; a view at the left edge
    /// starts at the inset rather than behind the ruler.
    func alignToInsets() {
        let clip = scroll.contentView
        let left = clip.contentInsets.left, top = clip.contentInsets.top
        var o = clip.bounds.origin
        guard (o.x > -left && o.x <= 0) || (o.y > -top && o.y <= 0) else { return }
        if o.x > -left && o.x <= 0 { o.x = -left }
        if o.y > -top && o.y <= 0 { o.y = -top }
        clip.scroll(to: o)
        scroll.reflectScrolledClipView(clip)
    }

    // MARK: EditorHost

    var storage: NSTextStorage { textStorage! }
    var selection: NSRange {
        get { selectedRange() }
        set { setSelectedRange(newValue) }
    }
    var hasMarkedText: Bool { hasMarkedText() }

    func perform(_ edit: TextEdit) {
        guard shouldChangeText(in: edit.range, replacementString: edit.text) else { return }
        textStorage?.replaceCharacters(in: edit.range, with: edit.text)
        didChangeText()
        setSelectedRange(edit.selection)
        scrollRangeToVisible(edit.selection)
    }

    func popupsChanged() { layoutPopups() }

    func decorationsChanged() {
        ruler.updateThickness()
        ruler.needsDisplay = true
        let r = currentLineRect() ?? .zero
        if r != lastLineRect {
            setNeedsDisplay(lastLineRect.insetBy(dx: 0, dy: -1), avoidAdditionalLayout: true)
            setNeedsDisplay(r.insetBy(dx: 0, dy: -1), avoidAdditionalLayout: true)
            lastLineRect = r
        }
    }

    func resetTypingAttributes() { typingAttributes = engine.highlighter.baseAttributes(theme) }

    // MARK: Delegates

    func textStorage(_ textStorage: NSTextStorage, didProcessEditing editedMask: NSTextStorageEditActions, range editedRange: NSRange, changeInLength delta: Int) {
        if editedMask.contains(.editedCharacters) { engine.storageEdited(range: editedRange, delta: delta) }
    }

    func textDidChange(_ notification: Notification) { engine.flush() }

    func textViewDidChangeSelection(_ notification: Notification) { engine.selectionDidChange() }

    func undoManager(for view: NSTextView) -> UndoManager? { document?.undoManager }

    // MARK: Input

    override func insertText(_ string: Any, replacementRange: NSRange) {
        let s = (string as? String) ?? (string as? NSAttributedString)?.string ?? ""
        if !hasMarkedText(), replacementRange.location == NSNotFound, engine.insertText(s) { return }
        super.insertText(string, replacementRange: replacementRange)
    }

    override func insertNewline(_ sender: Any?) { if !engine.insertNewline() { super.insertNewline(sender) } }
    override func insertTab(_ sender: Any?) { if !engine.insertTab() { super.insertTab(sender) } }
    override func insertBacktab(_ sender: Any?) { if !engine.insertBacktab() { super.insertBacktab(sender) } }
    override func deleteBackward(_ sender: Any?) { if !engine.deleteBackward() { super.deleteBackward(sender) } }
    override func cancelOperation(_ sender: Any?) { if !engine.cancel() { engine.triggerCompletion() } }
    override func complete(_ sender: Any?) { engine.triggerCompletion() }
    override func moveUp(_ sender: Any?) { if !engine.moveCompletion(by: -1) { super.moveUp(sender) } }
    override func moveDown(_ sender: Any?) { if !engine.moveCompletion(by: 1) { super.moveDown(sender) } }

    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .control, event.charactersIgnoringModifiers == " " {
            engine.triggerCompletion()
            return
        }
        super.keyDown(with: event)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if window?.firstResponder === self, event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command {
            switch event.charactersIgnoringModifiers {
            case "/": engine.toggleComment(); return true
            case "]": engine.indent(outdent: false); return true
            case "[": engine.indent(outdent: true); return true
            default: break
            }
        }
        return super.performKeyEquivalent(with: event)
    }

    // MARK: Drawing

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        ruler?.needsDisplay = true
        completionView.needsDisplay = true
        bubbleView.needsDisplay = true
    }

    @objc private func scrolled() { ruler.needsDisplay = true }

    /// The rectangle of a whole line (all its wrapped fragments) in view coordinates.
    private func lineRect(_ line: Int) -> NSRect? {
        guard let lm = layoutManager, let tc = textContainer else { return nil }
        let start = engine.lines.start(ofLine: line)
        let length = storage.length
        var r: NSRect
        if start >= length {
            r = lm.extraLineFragmentRect
            if r.isEmpty {
                guard length > 0 else { return nil }
                r = lm.lineFragmentRect(forGlyphAt: lm.glyphIndexForCharacter(at: length - 1), effectiveRange: nil)
            }
        } else {
            let range = engine.lines.range(ofLine: line, in: engine.units)
            r = lm.lineFragmentRect(forGlyphAt: lm.glyphIndexForCharacter(at: range.location), effectiveRange: nil)
            if range.length > 0 { r = r.union(lm.lineFragmentRect(forGlyphAt: lm.glyphIndexForCharacter(at: range.end - 1), effectiveRange: nil)) }
        }
        _ = tc
        let o = textContainerOrigin
        return r.offsetBy(dx: o.x, dy: o.y)
    }

    private func currentLineRect() -> NSRect? {
        let sel = selectedRange()
        guard engine.configuration.highlightsCurrentLine,
              engine.lines.line(containing: sel.location) == engine.lines.line(containing: sel.end),
              let r = lineRect(engine.currentLine) else { return nil }
        return NSRect(x: 0, y: r.minY, width: bounds.width, height: r.height)
    }

    override func drawBackground(in rect: NSRect) {
        super.drawBackground(in: rect)
        if let r = currentLineRect(), r.intersects(rect) {
            theme.currentLine.setFill()
            r.fill()
        }
    }

    func drawGutter(in view: NSView) {
        guard let lm = layoutManager, let tc = textContainer else { return }
        let o = textContainerOrigin
        let visible = visibleRect.offsetBy(dx: -o.x, dy: -o.y)
        let sev = engine.lineSeverities, cur = engine.currentLine
        let lines = GutterRenderer.visibleLines(layoutManager: lm, container: tc, lines: engine.lines, rect: visible).map { item -> GutterLine in
            let y = view.convert(NSPoint(x: 0, y: item.rect.minY + o.y), from: self).y
            return GutterLine(number: item.line + 1, y: y, height: item.rect.height, current: item.line == cur, severity: sev[item.line])
        }
        GutterRenderer.draw(lines, size: view.bounds.size, theme: theme)
    }

    func gutterClicked(at point: NSPoint, in view: NSView) {
        guard let lm = layoutManager, let tc = textContainer else { return }
        let p = convert(point, from: view)
        let o = textContainerOrigin
        let y = p.y - o.y
        let line = y > lm.usedRect(for: tc).maxY ? engine.lines.count - 1
            : engine.lines.line(containing: lm.characterIndex(for: NSPoint(x: 1, y: y), in: tc, fractionOfDistanceBetweenInsertionPoints: nil))
        engine.toggleBubble(line: line)
    }

    private func caretRect() -> NSRect {
        guard let lm = layoutManager, let tc = textContainer else { return .zero }
        let loc = selectedRange().location, length = storage.length
        var r: NSRect
        if length == 0 || (loc >= length && engine.units.last.map { $0 == UTF16Char.newline } == true) {
            r = lm.extraLineFragmentRect
            r.size.width = 1
        } else if loc >= length {
            let g = lm.glyphIndexForCharacter(at: length - 1)
            r = lm.boundingRect(forGlyphRange: NSRange(location: g, length: 1), in: tc)
            r.origin.x = r.maxX
        } else {
            let g = lm.glyphIndexForCharacter(at: loc)
            r = lm.boundingRect(forGlyphRange: NSRange(location: g, length: 1), in: tc)
        }
        let o = textContainerOrigin
        return r.offsetBy(dx: o.x, dy: o.y)
    }

    private func layoutPopups() {
        let area = visibleRect
        if let list = engine.completion {
            let caret = caretRect()
            let size = list.size(theme, maxWidth: area.width - 8)
            let prefixWidth = (list.context.prefix as NSString).size(withAttributes: [.font: theme.font]).width
            var x = caret.minX - prefixWidth - 26
            x = max(area.minX + 4, min(x, area.maxX - size.width - 4))
            var y = caret.maxY + 2
            if y + size.height > area.maxY, caret.minY - 2 - size.height >= area.minY { y = caret.minY - 2 - size.height }
            completionView.frame = NSRect(x: x, y: y, width: size.width, height: size.height)
            completionView.drawer = { [weak self] s in self.map { list.draw(size: s, theme: $0.theme) } }
            completionView.isHidden = false
            completionView.needsDisplay = true
        } else {
            completionView.isHidden = true
        }
        if let b = engine.bubble, let r = lineRect(b.line) {
            let size = b.bubble.size(theme, maxWidth: area.width - 16)
            let x = max(area.minX + 4, min(textContainerOrigin.x, area.maxX - size.width - 4))
            bubbleView.frame = NSRect(x: x, y: r.maxY + 2, width: size.width, height: size.height)
            bubbleView.drawer = { [weak self] s in self.map { b.bubble.draw(size: s, theme: $0.theme) } }
            bubbleView.isHidden = false
            bubbleView.needsDisplay = true
        } else {
            bubbleView.isHidden = true
        }
    }

    private func completionClicked(_ p: NSPoint) {
        guard let list = engine.completion, let row = list.row(at: p.y, theme) else { return }
        engine.selectCompletion(row)
        engine.acceptCompletion()
    }

    // MARK: Commands from the document

    func reveal(line: Int, column: Int?) {
        let l = max(0, min(line - 1, engine.lines.count - 1))
        let r = engine.lines.range(ofLine: l, in: engine.units)
        let loc = column.map { r.location + max(0, min($0 - 1, r.length)) } ?? r.location
        setSelectedRange(NSRange(location: loc, length: 0))
        scrollRangeToVisible(selectedRange())
    }

    func showFind(replace: Bool) {
        let item = NSMenuItem()
        item.tag = Int((replace ? NSTextFinder.Action.showReplaceInterface : NSTextFinder.Action.showFindInterface).rawValue)
        performTextFinderAction(item)
    }

    func focus() { window?.makeFirstResponder(self) }
}

/// The line-number gutter as the scroll view's vertical ruler.
final class GutterRulerView: NSRulerView {
    weak var codeView: CodeTextView?

    init(textView: CodeTextView) {
        codeView = textView
        super.init(scrollView: textView.scroll, orientation: .verticalRuler)
        clientView = textView
        updateThickness()
    }

    required init(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }

    func updateThickness() {
        guard let v = codeView else { return }
        let w = GutterRenderer.width(lineCount: v.engine.lines.count, theme: v.engine.theme)
        if ruleThickness != w {
            ruleThickness = w
            scrollView?.tile()
            v.alignToInsets()
        }
    }

    override var requiredThickness: CGFloat { ruleThickness }

    override func draw(_ dirtyRect: NSRect) { codeView?.drawGutter(in: self) }

    override func drawHashMarksAndLabels(in rect: NSRect) {}

    override func mouseDown(with event: NSEvent) {
        codeView?.gutterClicked(at: convert(event.locationInWindow, from: nil), in: self)
    }
}

/// A view that draws with a closure: the completion list, the diagnostic bubble.
final class PopupView: NSView {
    var drawer: ((CGSize) -> Void)?
    var onClick: ((NSPoint) -> Void)?
    var onScroll: ((Int) -> Void)?
    private var scrollAccumulator: CGFloat = 0

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        shadow = {
            let s = NSShadow()
            s.shadowColor = NSColor.black.withAlphaComponent(0.18)
            s.shadowBlurRadius = 8
            s.shadowOffset = NSSize(width: 0, height: -3)
            return s
        }()
    }

    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) { drawer?(bounds.size) }
    override func mouseDown(with event: NSEvent) { onClick?(convert(event.locationInWindow, from: nil)) }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .arrow) }
    override func scrollWheel(with event: NSEvent) {
        guard let onScroll else { return super.scrollWheel(with: event) }
        scrollAccumulator -= event.scrollingDeltaY / (event.hasPreciseScrollingDeltas ? 20 : 1)
        let rows = Int(scrollAccumulator)
        if rows != 0 { scrollAccumulator -= CGFloat(rows); onScroll(rows) }
    }
}
#endif
