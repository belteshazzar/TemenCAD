import Foundation

/// A completion's insert text with fields: `box(${w}, ${h})` inserts `box(w, h)` with `w` and `h` as
/// fields, `${}` an empty one; `${1:name}` is read as `name`. When there are fields, a last empty one
/// after the text lets the final Tab land after the closing bracket.
public struct Snippet: Equatable {
    public let text: String
    /// Field ranges in UTF-16 units, relative to the start of the text, in Tab order.
    public let fields: [NSRange]

    public init(template: String) {
        let u = Array(template.utf16)
        var out: [UInt16] = [], fields: [NSRange] = []
        var i = 0
        while i < u.count {
            if u[i] == UTF16Char.backslash, i + 1 < u.count, u[i + 1] == UTF16Char.dollar { out.append(UTF16Char.dollar); i += 2; continue }
            if u[i] == UTF16Char.dollar, i + 1 < u.count, u[i + 1] == UTF16Char.lbrace,
               let close = u[(i + 2)...].firstIndex(of: UTF16Char.rbrace) {
                var name = Array(u[(i + 2)..<close])
                if let colon = name.firstIndex(of: UTF16Char.colon), name[..<colon].allSatisfy(UTF16Char.isDigit) { name = Array(name[(colon + 1)...]) }
                fields.append(NSRange(location: out.count, length: name.count))
                out += name
                i = close + 1
                continue
            }
            out.append(u[i]); i += 1
        }
        if let last = fields.last, !(last.length == 0 && last.location == out.count) {
            fields.append(NSRange(location: out.count, length: 0))
        }
        text = String(decoding: out, as: UTF16.self)
        self.fields = fields
    }
}

/// The fields of an inserted snippet while Tab moves through them; edits move them along.
struct SnippetSession {
    var fields: [NSRange]
    var current: Int

    /// Follows an edit (`range` in the new text, `delta` the change in length). False ends the session:
    /// an edit outside the fields.
    mutating func adjust(editedRange range: NSRange, delta: Int) -> Bool {
        let oldEnd = range.end - delta // end of the replaced text in the old coordinates
        var inside = false
        for k in fields.indices {
            var f = fields[k]
            if range.location >= f.location && oldEnd <= f.end {
                f.length += delta; inside = true
            } else if range.location >= f.end {
                // after this field
            } else if oldEnd <= f.location {
                f.location += delta
            } else {
                return false
            }
            fields[k] = f
        }
        return inside
    }
}
