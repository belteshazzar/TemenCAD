import Foundation

/// Where each line starts, in UTF-16 units. A text ending in a newline has an empty last line.
struct LineIndex {
    private(set) var starts: [Int] = [0]
    private(set) var length = 0

    init(_ s: [UInt16] = []) {
        length = s.count
        starts = [0]
        var i = 0
        while i < s.count {
            let c = s[i]
            if c == UTF16Char.newline { starts.append(i + 1) }
            else if c == UTF16Char.cr {
                if i + 1 < s.count && s[i + 1] == UTF16Char.newline { i += 1 }
                starts.append(i + 1)
            }
            i += 1
        }
    }

    var count: Int { starts.count }

    /// The 0-based line containing `position`.
    func line(containing position: Int) -> Int {
        var lo = 0, hi = starts.count - 1
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            if starts[mid] <= position { lo = mid } else { hi = mid - 1 }
        }
        return lo
    }

    func start(ofLine line: Int) -> Int { starts[max(0, min(line, starts.count - 1))] }

    /// The line's range without its line break.
    func range(ofLine line: Int, in s: [UInt16]) -> NSRange {
        let a = start(ofLine: line)
        var b = line + 1 < starts.count ? starts[line + 1] : length
        while b > a && (s[b - 1] == UTF16Char.newline || s[b - 1] == UTF16Char.cr) { b -= 1 }
        return NSRange(location: a, length: b - a)
    }
}
