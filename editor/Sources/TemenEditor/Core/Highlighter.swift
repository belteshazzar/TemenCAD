import Foundation
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// Colours a text storage from its tokens. After an edit it compares the new tokens with the previous
/// ones and recolours only the span that differs, so typing in a long file stays cheap.
@MainActor
final class Highlighter {
    private(set) var tokens: [Token] = []

    func baseAttributes(_ theme: EditorTheme) -> [NSAttributedString.Key: Any] {
        [.font: theme.font, .foregroundColor: theme.text]
    }

    /// Colours everything.
    func applyAll(_ new: [Token], to storage: NSTextStorage, theme: EditorTheme) {
        tokens = new
        let all = NSRange(location: 0, length: storage.length)
        storage.beginEditing()
        storage.addAttributes(baseAttributes(theme), range: all)
        for t in new { color(t, storage, theme) }
        storage.endEditing()
    }

    /// Colours the span that changed with an edit (`edited` in the new text, `delta` the change in length).
    func apply(_ new: [Token], to storage: NSTextStorage, edited: NSRange, delta: Int, theme: EditorTheme) {
        let old = tokens
        tokens = new
        var p = 0
        while p < old.count && p < new.count && old[p] == new[p] && new[p].end < edited.location { p += 1 }
        var q = 0
        while q < old.count - p && q < new.count - p {
            let o = old[old.count - 1 - q], n = new[new.count - 1 - q]
            if o.kind == n.kind && o.length == n.length && o.location + delta == n.location && n.location > edited.end { q += 1 } else { break }
        }
        var start = edited.location, end = edited.end
        if p < new.count - q {
            start = min(start, new[p].location)
            end = max(end, new[new.count - 1 - q].end)
        }
        if p > 0 { start = min(start, new[p - 1].end) }
        if q > 0 { end = max(end, new[new.count - q].location) }
        start = max(0, min(start, storage.length))
        end = max(start, min(end, storage.length))
        guard end > start else { return }
        let span = NSRange(location: start, length: end - start)
        storage.beginEditing()
        storage.addAttributes(baseAttributes(theme), range: span)
        for t in new[p..<(new.count - q)] { color(t, storage, theme) }
        storage.endEditing()
    }

    private func color(_ t: Token, _ storage: NSTextStorage, _ theme: EditorTheme) {
        guard t.end <= storage.length, t.kind != .identifier, t.kind != .punctuation else { return }
        var attrs: [NSAttributedString.Key: Any] = [.foregroundColor: theme.color(for: t.kind)]
        if t.kind == .comment && theme.italicComments { attrs[.font] = theme.italicFont }
        storage.addAttributes(attrs, range: t.range)
    }
}

/// Attributes laid over the colours (backgrounds for matching brackets and words, underlines for
/// diagnostics), remembered so they can be taken off again, and moved along by edits.
struct Overlays {
    var backgrounds: [NSRange] = []
    var underlines: [NSRange] = []

    static func shift(_ ranges: [NSRange], edited: NSRange, delta: Int) -> [NSRange] {
        let oldEnd = edited.end - delta
        return ranges.compactMap { r in
            if r.location >= oldEnd { return NSRange(location: r.location + delta, length: r.length) }
            if r.end <= edited.location { return r }
            return nil
        }
    }

    mutating func shift(edited: NSRange, delta: Int) {
        backgrounds = Self.shift(backgrounds, edited: edited, delta: delta)
        underlines = Self.shift(underlines, edited: edited, delta: delta)
    }
}
