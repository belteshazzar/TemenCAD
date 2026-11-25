import Foundation
#if canImport(UIKit)
import UIKit
public typealias PlatformFont = UIFont
public typealias PlatformColor = UIColor
#elseif canImport(AppKit)
import AppKit
public typealias PlatformFont = NSFont
public typealias PlatformColor = NSColor
#endif

extension PlatformColor {
    /// A colour from 0xRRGGBB (and an optional alpha).
    public convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
                  blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
    }

    /// A colour that follows light and dark appearance.
    public static func dynamic(light: PlatformColor, dark: PlatformColor) -> PlatformColor {
        #if canImport(UIKit)
        return UIColor { $0.userInterfaceStyle == .dark ? dark : light }
        #else
        return NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
        }
        #endif
    }

    public static func dynamic(light: UInt32, dark: UInt32) -> PlatformColor {
        dynamic(light: PlatformColor(hex: light), dark: PlatformColor(hex: dark))
    }
}

/// The current Core Graphics context while a view draws, on either platform.
func currentContext() -> CGContext? {
    #if canImport(UIKit)
    return UIGraphicsGetCurrentContext()
    #else
    return NSGraphicsContext.current?.cgContext
    #endif
}

func fill(_ rect: CGRect, _ color: PlatformColor) {
    guard let cg = currentContext() else { return }
    cg.setFillColor(color.cgColor)
    cg.fill(rect)
}

func fillRounded(_ rect: CGRect, radius: CGFloat, _ color: PlatformColor) {
    guard let cg = currentContext() else { return }
    cg.setFillColor(color.cgColor)
    cg.addPath(CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil))
    cg.fillPath()
}

func strokeRounded(_ rect: CGRect, radius: CGFloat, _ color: PlatformColor, width: CGFloat = 1) {
    guard let cg = currentContext() else { return }
    cg.setStrokeColor(color.cgColor)
    cg.setLineWidth(width)
    cg.addPath(CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil))
    cg.strokePath()
}

extension NSRange {
    var end: Int { location + length }
    func contains(position p: Int) -> Bool { p >= location && p <= end }
}

/// UTF-16 code units of a string, the unit NSString ranges count in.
enum UTF16Char {
    static let tab: UInt16 = 9, newline: UInt16 = 10, cr: UInt16 = 13, space: UInt16 = 32
    static let quote: UInt16 = 34, dollar: UInt16 = 36, apostrophe: UInt16 = 39
    static let lparen: UInt16 = 40, rparen: UInt16 = 41, star: UInt16 = 42, comma: UInt16 = 44
    static let dot: UInt16 = 46, slash: UInt16 = 47, colon: UInt16 = 58, semicolon: UInt16 = 59
    static let question: UInt16 = 63, lbracket: UInt16 = 91, backslash: UInt16 = 92, rbracket: UInt16 = 93
    static let backtick: UInt16 = 96, lbrace: UInt16 = 123, rbrace: UInt16 = 125

    static func isWhitespace(_ c: UInt16) -> Bool {
        c == space || c == tab || c == newline || c == cr || c == 0x0b || c == 0x0c || c == 0xa0
            || c == 0xfeff || c == 0x2028 || c == 0x2029
    }
    static func isDigit(_ c: UInt16) -> Bool { c >= 48 && c <= 57 }
    static func isIdentifierStart(_ c: UInt16) -> Bool {
        (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 || c == dollar || (c >= 0x80 && !isWhitespace(c))
    }
    static func isIdentifierPart(_ c: UInt16) -> Bool { isIdentifierStart(c) || isDigit(c) }
    static func isOpener(_ c: UInt16) -> Bool { c == lparen || c == lbracket || c == lbrace }
    static func isCloser(_ c: UInt16) -> Bool { c == rparen || c == rbracket || c == rbrace }
    static func closer(for c: UInt16) -> UInt16? {
        switch c { case lparen: return rparen; case lbracket: return rbracket; case lbrace: return rbrace; default: return nil }
    }
}

extension Array where Element == UInt16 {
    func string(_ range: NSRange) -> String {
        let lo = Swift.max(0, Swift.min(range.location, count)), hi = Swift.max(lo, Swift.min(range.end, count))
        return String(decoding: self[lo..<hi], as: UTF16.self)
    }
}
