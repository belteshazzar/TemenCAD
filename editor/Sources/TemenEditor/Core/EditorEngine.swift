import Foundation
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// What the engine needs from a platform text view.
@MainActor
protocol EditorHost: AnyObject {
    var storage: NSTextStorage { get }
    var selection: NSRange { get set }
    var hasMarkedText: Bool { get }
    /// Replaces text as one undoable change and selects `edit.selection`.
    func perform(_ edit: TextEdit)
    /// The completion list or the diagnostic bubble appeared, changed or went.
    func popupsChanged()
    /// Line numbers, markers or the current line need drawing again.
    func decorationsChanged()
    func resetTypingAttributes()
}

/// The editor's behaviour, shared by the iOS and macOS text views: tokens and colours, the editing
/// rules, completion and snippet fields, diagnostics, bracket and word matches.
@MainActor
final class EditorEngine {
    weak var host: EditorHost?
    var configuration: EditorConfiguration
    var onTextChange: ((String) -> Void)?
    var onSelectionChange: ((NSRange) -> Void)?

    private(set) var units: [UInt16] = []
    private(set) var lines = LineIndex()
    let highlighter = Highlighter()
    var tokens: [Token] { highlighter.tokens }
    private var overlays = Overlays()

    private(set) var completion: CompletionList?
    private var snippet: SnippetSession?
    private(set) var diagnostics: [(Diagnostic, NSRange)] = []
    private(set) var bubble: (line: Int, bubble: DiagnosticBubble)?

    private var pending: (range: NSRange, delta: Int)?
    private var pendingFull = false
    private var openCompletion = false
    private var applying = false

    init(configuration: EditorConfiguration) {
        self.configuration = configuration
    }

    var theme: EditorTheme { configuration.theme }

    // MARK: - Text changes

    /// Everything again: after loading text or changing the configuration.
    func reload() {
        guard let host else { return }
        units = Array(host.storage.string.utf16)
        lines = LineIndex(units)
        let s = host.storage
        s.beginEditing()
        let all = NSRange(location: 0, length: s.length)
        s.removeAttribute(.backgroundColor, range: all)
        s.removeAttribute(.underlineStyle, range: all)
        s.removeAttribute(.underlineColor, range: all)
        s.endEditing()
        overlays = Overlays()
        highlighter.applyAll(configuration.language.tokenize(units), to: s, theme: theme)
        resolveDiagnostics(diagnostics.map(\.0))
        refreshOverlays()
        host.resetTypingAttributes()
        host.decorationsChanged()
    }

    /// From the text storage's delegate: characters changed (`range` in the new text).
    func storageEdited(range: NSRange, delta: Int) {
        if let p = pending {
            // several edits in one change: cover them all
            let oldStart = min(p.range.location, range.location)
            let end = max(p.range.end + delta, range.end)
            pending = (NSRange(location: oldStart, length: max(0, end - oldStart)), p.delta + delta)
            pendingFull = true
        } else {
            pending = (range, delta)
        }
    }

    /// After the text view finished a change.
    func flush() {
        guard let p = pending, let host, !host.hasMarkedText else { return }
        pending = nil
        let full = pendingFull
        pendingFull = false
        units = Array(host.storage.string.utf16)
        lines = LineIndex(units)
        let s = host.storage
        let edited = NSRange(location: min(p.range.location, s.length), length: max(0, min(p.range.length, s.length - min(p.range.location, s.length))))
        // inserted text may have taken on overlay attributes from its neighbours
        if edited.length > 0 {
            s.beginEditing()
            s.removeAttribute(.backgroundColor, range: edited)
            s.removeAttribute(.underlineStyle, range: edited)
            s.removeAttribute(.underlineColor, range: edited)
            s.endEditing()
        }
        overlays.shift(edited: edited, delta: p.delta)
        let new = configuration.language.tokenize(units)
        if full { highlighter.applyAll(new, to: s, theme: theme) }
        else { highlighter.apply(new, to: s, edited: edited, delta: p.delta, theme: theme) }
        if var sn = snippet { snippet = sn.adjust(editedRange: edited, delta: p.delta) ? sn : nil; _ = sn }
        shiftDiagnostics(edited: edited, delta: p.delta)
        bubble = nil
        if completion != nil || openCompletion { updateCompletion(explicit: completion?.context.explicit ?? false) }
        openCompletion = false
        refreshOverlays()
        host.resetTypingAttributes()
        host.decorationsChanged()
        host.popupsChanged()
        onTextChange?(host.storage.string)
    }

    func selectionDidChange() {
        guard let host, !applying else { return }
        if pending != nil { return } // a change is on its way; flush handles it
        let sel = host.selection
        if let c = completion, sel.length > 0 || !c.context.range.contains(position: sel.location) {
            completion = nil
        }
        if let sn = snippet, !sn.fields.contains(where: { NSIntersectionRange($0, sel).length > 0 || $0.contains(position: sel.location) && $0.contains(position: sel.end) }) {
            snippet = nil
        }
        bubble = nil
        refreshOverlays()
        host.resetTypingAttributes()
        host.decorationsChanged()
        host.popupsChanged()
        onSelectionChange?(sel)
    }

    private func perform(_ edit: TextEdit) {
        guard let host else { return }
        applying = true
        if edit.isSelectionOnly { host.selection = edit.selection } else { host.perform(edit) }
        applying = false
        flush()
        if edit.isSelectionOnly { selectionDidChange() } else { refreshOverlays(); host.decorationsChanged() }
        onSelectionChange?(host.selection)
    }

    /// Replaces the whole text: undoable as one change, or as a fresh start.
    func setText(_ text: String, undoable: Bool) {
        guard let host else { return }
        completion = nil; snippet = nil; bubble = nil
        let all = NSRange(location: 0, length: host.storage.length)
        if undoable {
            let keep = min(host.selection.location, (text as NSString).length)
            perform(TextEdit(range: all, text: text, selection: NSRange(location: keep, length: 0)))
        } else {
            host.storage.replaceCharacters(in: all, with: text)
            pending = nil; pendingFull = false
            host.selection = NSRange(location: 0, length: 0)
            reload()
            onTextChange?(text)
        }
    }

    // MARK: - Typing

    /// A character typed (or several, pasted). True when the engine made the edit itself.
    func insertText(_ s: String) -> Bool {
        guard let host, !applying, !host.hasMarkedText, configuration.isEditable else { return false }
        if s == "\n" { return insertNewline() }
        if s == "\t" { return insertTab() }
        if let c = s.utf16.first, s.utf16.count == 1 { openCompletion = UTF16Char.isIdentifierPart(c) || c == UTF16Char.dot }
        if let edit = EditingRules.insert(s, text: units, selection: host.selection, tokens: tokens, options: configuration.editing) {
            perform(edit)
            return true
        }
        return false
    }

    func deleteBackward() -> Bool {
        guard let host, !applying, !host.hasMarkedText else { return false }
        if let edit = EditingRules.deleteBackward(text: units, selection: host.selection, tokens: tokens, options: configuration.editing) {
            perform(edit)
            return true
        }
        return false
    }

    func insertNewline() -> Bool {
        guard let host, !applying else { return false }
        if completion != nil { acceptCompletion(); return true }
        perform(EditingRules.newline(text: units, selection: host.selection, tokens: tokens, options: configuration.editing))
        return true
    }

    func insertTab() -> Bool {
        guard let host, !applying else { return false }
        if completion != nil { acceptCompletion(); return true }
        if snippet != nil { moveField(by: 1); return true }
        perform(EditingRules.tab(text: units, selection: host.selection, options: configuration.editing))
        return true
    }

    func insertBacktab() -> Bool {
        guard let host, !applying else { return false }
        if snippet != nil { moveField(by: -1); return true }
        if let edit = EditingRules.indent(text: units, selection: host.selection, options: configuration.editing, outdent: true) { perform(edit) }
        return true
    }

    func indent(outdent: Bool) {
        guard let host else { return }
        if let edit = EditingRules.indent(text: units, selection: host.selection, options: configuration.editing, outdent: outdent) { perform(edit) }
    }

    /// Escape: closes the list, the bubble or the snippet fields; false when there was nothing to close.
    func cancel() -> Bool {
        if completion != nil { completion = nil; host?.popupsChanged(); return true }
        if bubble != nil { bubble = nil; host?.popupsChanged(); return true }
        if snippet != nil { snippet = nil; return true }
        return false
    }

    func toggleComment() {
        guard let host, let marker = configuration.language.lineComment, configuration.isEditable else { return }
        if let edit = EditingRules.toggleComment(text: units, selection: host.selection, marker: marker) { perform(edit) }
    }

    private func moveField(by d: Int) {
        guard var sn = snippet else { return }
        let next = sn.current + d
        guard sn.fields.indices.contains(next) else { if d > 0 { snippet = nil }; return }
        sn.current = next
        snippet = next == sn.fields.count - 1 ? nil : sn
        perform(TextEdit(range: NSRange(location: 0, length: 0), text: "", selection: sn.fields[next]))
    }

    // MARK: - Completion

    func triggerCompletion() { updateCompletion(explicit: true); host?.popupsChanged() }

    private func updateCompletion(explicit: Bool) {
        guard let host, host.selection.length == 0,
              let ctx = configuration.language.completionContext(text: units, tokens: tokens, cursor: host.selection.location, explicit: explicit)
        else { completion = nil; return }
        var items = configuration.completions?.completions(for: ctx) ?? []
        if case .global = ctx.kind { items += configuration.language.languageCompletions(text: units, tokens: tokens) }
        let ranked = CompletionMatcher.rank(items, prefix: ctx.prefix)
        if ranked.isEmpty || (!explicit && ranked.count == 1 && ranked[0].0.label == ctx.prefix) { completion = nil; return }
        let keep = completion.flatMap { old in old.items.indices.contains(old.selected) ? old.items[old.selected].0.label : nil }
        var list = CompletionList(items: ranked, selected: keep.flatMap { k in ranked.firstIndex { $0.0.label == k } } ?? 0, context: ctx)
        list.top = completion?.top ?? 0
        list.scrollToSelection()
        completion = list
    }

    func moveCompletion(by d: Int) -> Bool {
        guard var c = completion else { return false }
        c.selected = max(0, min(c.items.count - 1, c.selected + d))
        c.scrollToSelection()
        completion = c
        host?.popupsChanged()
        return true
    }

    func scrollCompletion(by rows: Int) {
        guard var c = completion else { return }
        c.top = max(0, min(c.items.count - c.visibleRows, c.top + rows))
        completion = c
        host?.popupsChanged()
    }

    func selectCompletion(_ i: Int) {
        guard var c = completion, c.items.indices.contains(i) else { return }
        c.selected = i
        completion = c
    }

    func acceptCompletion() {
        guard let c = completion, c.items.indices.contains(c.selected) else { return }
        let item = c.items[c.selected].0, ctx = c.context
        completion = nil
        host?.popupsChanged()
        if let template = item.snippet {
            let sn = Snippet(template: template)
            let fields = sn.fields.map { NSRange(location: $0.location + ctx.range.location, length: $0.length) }
            let end = ctx.range.location + (sn.text as NSString).length
            perform(TextEdit(range: ctx.range, text: sn.text, selection: fields.first ?? NSRange(location: end, length: 0)))
            if fields.count > 1 { snippet = SnippetSession(fields: fields, current: 0) }
        } else {
            perform(TextEdit(range: ctx.range, text: item.label, selection: NSRange(location: ctx.range.location + (item.label as NSString).length, length: 0)))
        }
    }

    // MARK: - Diagnostics

    func setDiagnostics(_ list: [Diagnostic]) {
        resolveDiagnostics(list)
        bubble = nil
        refreshOverlays()
        host?.decorationsChanged()
        host?.popupsChanged()
    }

    private func resolveDiagnostics(_ list: [Diagnostic]) {
        diagnostics = list.map { d in
            let line = max(0, min(d.line - 1, lines.count - 1))
            let lr = lines.range(ofLine: line, in: units)
            if let col = d.column {
                let loc = lr.location + max(0, min(col - 1, lr.length))
                var len = d.length ?? 0
                if d.length == nil {
                    if let t = tokens.token(around: loc + 1), t.location <= loc, t.end > loc { len = t.end - loc }
                    else { len = loc < lr.end ? 1 : 0 }
                }
                return (d, NSRange(location: loc, length: max(0, min(len, lr.end - loc))))
            }
            var a = lr.location
            while a < lr.end && (units[a] == UTF16Char.space || units[a] == UTF16Char.tab) { a += 1 }
            return (d, NSRange(location: a, length: lr.end - a))
        }
    }

    private func shiftDiagnostics(edited: NSRange, delta: Int) {
        let oldEnd = edited.end - delta
        diagnostics = diagnostics.map { d, r in
            if r.location >= oldEnd { return (d, NSRange(location: r.location + delta, length: r.length)) }
            if r.end <= edited.location { return (d, r) }
            // the edit touched it: keep it where the edit is, cut to what is left
            let loc = min(r.location, edited.location)
            return (d, NSRange(location: loc, length: max(0, min(r.end + delta, units.count) - loc)))
        }
    }

    /// The worst severity on each 0-based line.
    var lineSeverities: [Int: Diagnostic.Severity] {
        var out: [Int: Diagnostic.Severity] = [:]
        for (d, r) in diagnostics {
            let l = lines.line(containing: r.location)
            out[l] = max(out[l] ?? d.severity, d.severity)
        }
        return out
    }

    func diagnostics(onLine line: Int) -> [Diagnostic] {
        diagnostics.filter { lines.line(containing: $0.1.location) == line }.map(\.0)
    }

    /// Shows (or hides, when already shown) the messages of a line.
    func toggleBubble(line: Int) {
        if bubble?.line == line { bubble = nil }
        else {
            let msgs = diagnostics(onLine: line)
            bubble = msgs.isEmpty ? nil : (line, DiagnosticBubble(messages: msgs))
        }
        host?.popupsChanged()
    }

    var currentLine: Int { lines.line(containing: host?.selection.location ?? 0) }

    // MARK: - Overlays

    private func refreshOverlays() {
        guard let host else { return }
        let s = host.storage, length = s.length
        let sel = host.selection
        var backgrounds: [(NSRange, PlatformColor)] = []
        if sel.length == 0, let m = EditingRules.matchBracket(text: units, tokens: tokens, cursor: sel.location) {
            let color = m.matched ? theme.bracketMatch : theme.bracketMismatch
            backgrounds.append((m.bracket, color))
            if let p = m.partner { backgrounds.append((p, color)) }
        } else if sel.length > 0, sel.length < 200,
                  let t = tokens.first(where: { $0.location == sel.location && $0.length == sel.length }),
                  [.identifier, .definition, .function, .property].contains(t.kind) {
            let word = units[t.location..<t.end]
            var n = 0
            for u in tokens where u.length == t.length && u.location != t.location && [.identifier, .definition, .function, .property].contains(u.kind)
                && units[u.location..<u.end].elementsEqual(word) {
                backgrounds.append((u.range, theme.selectionMatch))
                n += 1
                if n > 500 { break }
            }
        }
        let underlines = diagnostics.filter { $0.1.length > 0 }
        s.beginEditing()
        for r in overlays.backgrounds where r.end <= length { s.removeAttribute(.backgroundColor, range: r) }
        for r in overlays.underlines where r.end <= length {
            s.removeAttribute(.underlineStyle, range: r)
            s.removeAttribute(.underlineColor, range: r)
        }
        overlays = Overlays()
        for (r, c) in backgrounds where r.end <= length {
            s.addAttribute(.backgroundColor, value: c, range: r)
            overlays.backgrounds.append(r)
        }
        for (d, r) in underlines.sorted(by: { $0.0.severity < $1.0.severity }) where r.end <= length {
            s.addAttributes([.underlineStyle: NSUnderlineStyle.thick.rawValue | NSUnderlineStyle.patternDot.rawValue,
                             .underlineColor: theme.color(for: d.severity)], range: r)
            overlays.underlines.append(r)
        }
        s.endEditing()
    }
}
