import Foundation
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// A line in the gutter: its 1-based number, the top and height of its first line fragment in gutter
/// coordinates, and what to mark.
struct GutterLine {
    var number: Int
    var y: CGFloat
    var height: CGFloat
    var current: Bool
    var severity: Diagnostic.Severity?
}

/// The line-number gutter, drawn the same way on both platforms.
enum GutterRenderer {
    static let markerWidth: CGFloat = 14
    static let padding: CGFloat = 8

    static func width(lineCount: Int, theme: EditorTheme) -> CGFloat {
        let digits = max(2, String(lineCount).count)
        let digit = ("8" as NSString).size(withAttributes: [.font: theme.font]).width
        return ceil(markerWidth + CGFloat(digits) * digit + padding)
    }

    /// Line fragments of the lines visible in `rect` (text container coordinates).
    @MainActor
    static func visibleLines(layoutManager lm: NSLayoutManager, container: NSTextContainer, lines: LineIndex, rect: CGRect) -> [(line: Int, rect: CGRect)] {
        guard let storage = lm.textStorage else { return [] }
        let length = storage.length
        if length == 0 { return [(0, lm.extraLineFragmentRect)] }
        let glyphs = lm.glyphRange(forBoundingRect: rect, in: container)
        let chars = lm.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        let first = lines.line(containing: chars.location)
        var last = lines.line(containing: max(chars.location, chars.end - 1))
        if lines.start(ofLine: lines.count - 1) == length && !lm.extraLineFragmentRect.isEmpty && lm.extraLineFragmentRect.minY <= rect.maxY {
            last = lines.count - 1
        }
        var out: [(Int, CGRect)] = []
        for line in first...max(first, last) {
            let start = lines.start(ofLine: line)
            if start >= length {
                let extra = lm.extraLineFragmentRect
                if !extra.isEmpty { out.append((line, extra)) }
                continue
            }
            let g = lm.glyphIndexForCharacter(at: start)
            out.append((line, lm.lineFragmentRect(forGlyphAt: g, effectiveRange: nil)))
        }
        return out
    }

    static func draw(_ lines: [GutterLine], size: CGSize, theme: EditorTheme) {
        fill(CGRect(origin: .zero, size: size), theme.gutterBackground)
        fill(CGRect(x: size.width - 1, y: 0, width: 1, height: size.height), theme.gutterBorder)
        let lineHeight = theme.lineHeight
        for l in lines {
            if let sev = l.severity {
                let d: CGFloat = 8
                let r = CGRect(x: (markerWidth - d) / 2 + 1, y: l.y + (min(l.height, lineHeight) - d) / 2, width: d, height: d)
                guard let cg = currentContext() else { continue }
                cg.setFillColor(theme.color(for: sev).cgColor)
                cg.fillEllipse(in: r)
            }
            let s = String(l.number) as NSString
            let attrs: [NSAttributedString.Key: Any] = [.font: theme.font, .foregroundColor: l.current ? theme.gutterCurrentText : theme.gutterText]
            let w = s.size(withAttributes: attrs).width
            s.draw(at: CGPoint(x: size.width - padding - w, y: l.y), withAttributes: attrs)
        }
    }
}

/// The completion list: rows of label and signature, and the selected entry's description under them.
struct CompletionList {
    var items: [(Completion, CompletionMatcher.Match)]
    var selected: Int
    var top: Int = 0
    var context: CompletionContext

    static let maxRows = 8
    static let width: CGFloat = 380

    func rowHeight(_ theme: EditorTheme) -> CGFloat { ceil(theme.lineHeight + 6) }
    var visibleRows: Int { min(items.count, Self.maxRows) }

    mutating func scrollToSelection() {
        if selected < top { top = selected }
        if selected >= top + Self.maxRows { top = selected - Self.maxRows + 1 }
        top = max(0, min(top, items.count - visibleRows))
    }

    private func info(_ theme: EditorTheme) -> NSAttributedString? {
        guard items.indices.contains(selected), let info = items[selected].0.info, !info.isEmpty else { return nil }
        return NSAttributedString(string: info, attributes: [.font: PlatformFont.systemFont(ofSize: theme.font.pointSize - 1), .foregroundColor: theme.popupSecondaryText])
    }

    private func infoHeight(_ theme: EditorTheme, width: CGFloat) -> CGFloat {
        guard let s = info(theme) else { return 0 }
        let r = s.boundingRect(with: CGSize(width: width - 16, height: 200), options: [.usesLineFragmentOrigin], context: nil)
        return ceil(min(r.height, theme.lineHeight * 4)) + 10
    }

    func size(_ theme: EditorTheme, maxWidth: CGFloat) -> CGSize {
        let w = min(Self.width, maxWidth)
        return CGSize(width: w, height: CGFloat(visibleRows) * rowHeight(theme) + infoHeight(theme, width: w) + 4)
    }

    /// The row at a point, or nil.
    func row(at y: CGFloat, _ theme: EditorTheme) -> Int? {
        let r = Int((y - 2) / rowHeight(theme))
        guard y >= 2, r >= 0, r < visibleRows else { return nil }
        return top + r
    }

    func draw(size: CGSize, theme: EditorTheme) {
        let bounds = CGRect(origin: .zero, size: size)
        fillRounded(bounds.insetBy(dx: 0.5, dy: 0.5), radius: 6, theme.popupBackground)
        strokeRounded(bounds.insetBy(dx: 0.5, dy: 0.5), radius: 6, theme.popupBorder)
        let rh = rowHeight(theme)
        let bold = PlatformFont.monospacedSystemFont(ofSize: theme.font.pointSize, weight: .bold)
        for r in 0..<visibleRows {
            let i = top + r
            let (c, m) = items[i]
            let rowRect = CGRect(x: 2, y: 2 + CGFloat(r) * rh, width: size.width - 4, height: rh)
            if i == selected { fillRounded(rowRect, radius: 4, theme.popupSelection) }
            // kind badge
            let badge = Self.badge(c.kind)
            let badgeAttrs: [NSAttributedString.Key: Any] = [.font: PlatformFont.systemFont(ofSize: theme.font.pointSize - 3, weight: .semibold), .foregroundColor: Self.badgeColor(c.kind, theme)]
            let bs = (badge as NSString).size(withAttributes: badgeAttrs)
            (badge as NSString).draw(at: CGPoint(x: rowRect.minX + 6 + (12 - bs.width) / 2, y: rowRect.midY - bs.height / 2), withAttributes: badgeAttrs)
            // label with the matched characters in bold
            let label = NSMutableAttributedString(string: c.label, attributes: [.font: theme.font, .foregroundColor: theme.popupText])
            let len = (c.label as NSString).length
            for p in m.positions where p < len {
                label.addAttributes([.font: bold, .foregroundColor: theme.popupMatch], range: NSRange(location: p, length: 1))
            }
            let ls = label.size()
            let x0 = rowRect.minX + 24
            label.draw(at: CGPoint(x: x0, y: rowRect.midY - ls.height / 2))
            if let detail = c.detail {
                let attrs: [NSAttributedString.Key: Any] = [.font: PlatformFont.monospacedSystemFont(ofSize: theme.font.pointSize - 2, weight: .regular), .foregroundColor: theme.popupSecondaryText]
                let ds = (detail as NSString).size(withAttributes: attrs)
                let avail = rowRect.maxX - 8 - (x0 + ls.width + 12)
                if avail > 30 {
                    let r = CGRect(x: x0 + ls.width + 12, y: rowRect.midY - ds.height / 2, width: avail, height: ds.height)
                    let para = NSMutableParagraphStyle()
                    para.lineBreakMode = .byTruncatingTail
                    var a = attrs; a[.paragraphStyle] = para
                    (detail as NSString).draw(in: r, withAttributes: a)
                }
            }
        }
        if items.count > Self.maxRows {
            // a thin scroll indicator
            let track = CGFloat(visibleRows) * rh
            let h = max(12, track * CGFloat(Self.maxRows) / CGFloat(items.count))
            let y = 2 + (track - h) * CGFloat(top) / CGFloat(items.count - Self.maxRows)
            fillRounded(CGRect(x: size.width - 5, y: y, width: 3, height: h), radius: 1.5, theme.popupBorder)
        }
        if let s = info(theme) {
            let y = 2 + CGFloat(visibleRows) * rh
            fill(CGRect(x: 1, y: y, width: size.width - 2, height: 1), theme.popupBorder)
            s.draw(with: CGRect(x: 8, y: y + 5, width: size.width - 16, height: size.height - y - 7), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
        }
    }

    static func badge(_ k: Completion.Kind) -> String {
        switch k {
        case .function: return "ƒ"
        case .method: return "m"
        case .variable: return "x"
        case .constant: return "c"
        case .keyword: return "k"
        case .property: return "p"
        case .snippet: return "{}"
        case .text: return "·"
        }
    }

    static func badgeColor(_ k: Completion.Kind, _ theme: EditorTheme) -> PlatformColor {
        switch k {
        case .function, .method: return theme.color(for: .function) == theme.text ? theme.info : theme.color(for: .function)
        case .keyword: return theme.color(for: .keyword)
        case .constant: return theme.color(for: .constant)
        default: return theme.popupSecondaryText
        }
    }
}

/// The messages of a line, shown in a bubble under it.
struct DiagnosticBubble {
    var messages: [Diagnostic]
    static let maxWidth: CGFloat = 460

    private func text(_ theme: EditorTheme) -> NSAttributedString {
        let s = NSMutableAttributedString()
        for (i, d) in messages.enumerated() {
            if i > 0 { s.append(NSAttributedString(string: "\n")) }
            let label: String
            switch d.severity { case .error: label = "Error: "; case .warning: label = "Warning: "; case .info: label = "" }
            s.append(NSAttributedString(string: label, attributes: [.font: PlatformFont.systemFont(ofSize: theme.font.pointSize - 1, weight: .semibold), .foregroundColor: theme.color(for: d.severity)]))
            s.append(NSAttributedString(string: d.message, attributes: [.font: PlatformFont.systemFont(ofSize: theme.font.pointSize - 1), .foregroundColor: theme.popupText]))
        }
        return s
    }

    func size(_ theme: EditorTheme, maxWidth: CGFloat) -> CGSize {
        let w = min(Self.maxWidth, maxWidth)
        let r = text(theme).boundingRect(with: CGSize(width: w - 22, height: 400), options: [.usesLineFragmentOrigin], context: nil)
        return CGSize(width: min(w, ceil(r.width) + 22), height: ceil(r.height) + 14)
    }

    func draw(size: CGSize, theme: EditorTheme) {
        let bounds = CGRect(origin: .zero, size: size).insetBy(dx: 0.5, dy: 0.5)
        fillRounded(bounds, radius: 6, theme.popupBackground)
        strokeRounded(bounds, radius: 6, theme.popupBorder)
        let worst = messages.map(\.severity).max() ?? .info
        fillRounded(CGRect(x: 4, y: 5, width: 3, height: size.height - 10), radius: 1.5, theme.color(for: worst))
        text(theme).draw(with: CGRect(x: 14, y: 7, width: size.width - 22, height: size.height - 14), options: [.usesLineFragmentOrigin], context: nil)
    }
}
