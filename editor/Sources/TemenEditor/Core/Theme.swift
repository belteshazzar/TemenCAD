import Foundation
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// Fonts and colours. The default follows light and dark appearance.
public struct EditorTheme {
    /// Names the theme; the editor redraws everything when the name or the font changes.
    public var name: String
    public var font: PlatformFont
    public var text: PlatformColor
    public var background: PlatformColor
    public var tokens: [TokenKind: PlatformColor]
    public var italicComments: Bool
    public var currentLine: PlatformColor
    public var selectionMatch: PlatformColor
    public var bracketMatch: PlatformColor
    public var bracketMismatch: PlatformColor
    public var gutterBackground: PlatformColor
    public var gutterText: PlatformColor
    public var gutterCurrentText: PlatformColor
    public var gutterBorder: PlatformColor
    public var error: PlatformColor
    public var warning: PlatformColor
    public var info: PlatformColor
    public var popupBackground: PlatformColor
    public var popupBorder: PlatformColor
    public var popupSelection: PlatformColor
    public var popupText: PlatformColor
    public var popupSecondaryText: PlatformColor
    public var popupMatch: PlatformColor

    public static func monospacedFont(size: CGFloat) -> PlatformFont {
        PlatformFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }

    #if canImport(UIKit)
    public static let defaultFontSize: CGFloat = 14
    #else
    public static let defaultFontSize: CGFloat = 13
    #endif

    /// Colours of CodeMirror's default highlight style in light mode, as in the web app, and of One Dark in dark mode.
    public static var standard: EditorTheme {
        let d = PlatformColor.dynamic(light:dark:) as (UInt32, UInt32) -> PlatformColor
        return EditorTheme(
            name: "standard",
            font: monospacedFont(size: defaultFontSize),
            text: d(0x1f1d1a, 0xabb2bf),
            background: d(0xffffff, 0x21252b),
            tokens: [
                .keyword: d(0x770088, 0xc678dd),
                .invalid: d(0xff0000, 0xff5c57),
                .constant: d(0x221199, 0xd19a66),
                .identifier: d(0x1f1d1a, 0xabb2bf),
                .definition: d(0x0000ff, 0xe5c07b),
                .function: d(0x1f1d1a, 0x61afef),
                .property: d(0x1f1d1a, 0xe06c75),
                .number: d(0x116644, 0xd19a66),
                .string: d(0xaa1111, 0x98c379),
                .regex: d(0xee4400, 0x56b6c2),
                .comment: d(0x994400, 0x7d8799),
                .operator: d(0x1f1d1a, 0x56b6c2),
                .punctuation: d(0x1f1d1a, 0xabb2bf),
                .bracket: d(0x1f1d1a, 0xabb2bf),
            ],
            italicComments: true,
            currentLine: .dynamic(light: PlatformColor(hex: 0xf3f1ec), dark: PlatformColor(hex: 0x2c313a)),
            selectionMatch: .dynamic(light: PlatformColor(hex: 0x72a1ff, alpha: 0.2), dark: PlatformColor(hex: 0x72a1ff, alpha: 0.2)),
            bracketMatch: .dynamic(light: PlatformColor(hex: 0x328c32, alpha: 0.25), dark: PlatformColor(hex: 0xbad0f8, alpha: 0.25)),
            bracketMismatch: .dynamic(light: PlatformColor(hex: 0xbb5555, alpha: 0.35), dark: PlatformColor(hex: 0xff5c57, alpha: 0.35)),
            gutterBackground: d(0xffffff, 0x21252b),
            gutterText: d(0xa8a49c, 0x5c6370),
            gutterCurrentText: d(0x4d4a45, 0xabb2bf),
            gutterBorder: d(0xe4e0d8, 0x2c313a),
            error: d(0xd11f1f, 0xff5c57),
            warning: d(0xc48a00, 0xe5c07b),
            info: d(0x3b7bd6, 0x61afef),
            popupBackground: d(0xffffff, 0x2c313a),
            popupBorder: d(0xd8d4cc, 0x3e4451),
            popupSelection: .dynamic(light: PlatformColor(hex: 0x3b7bd6, alpha: 0.16), dark: PlatformColor(hex: 0x61afef, alpha: 0.25)),
            popupText: d(0x1f1d1a, 0xdcdfe4),
            popupSecondaryText: d(0x7a766e, 0x8b929e),
            popupMatch: d(0x1d5bb8, 0x7fc1ff))
    }

    public func color(for kind: TokenKind) -> PlatformColor { tokens[kind] ?? text }

    func color(for severity: Diagnostic.Severity) -> PlatformColor {
        switch severity { case .error: return error; case .warning: return warning; case .info: return info }
    }

    var italicFont: PlatformFont {
        #if canImport(UIKit)
        if let d = font.fontDescriptor.withSymbolicTraits(.traitItalic) { return UIFont(descriptor: d, size: font.pointSize) }
        return font
        #else
        return NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
        #endif
    }

    var lineHeight: CGFloat {
        #if canImport(UIKit)
        return font.lineHeight
        #else
        return ceil(font.ascender - font.descender + font.leading)
        #endif
    }
}
