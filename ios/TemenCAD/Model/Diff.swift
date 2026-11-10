import Foundation

/// Line diff for the "Changes" view: unified hunks with a few lines of context. A port of the web app's
/// src/diff.js (same output): common prefix and suffix trimmed first, then an LCS table when the middle
/// is small enough, otherwise shown as removed then added.
enum Diff {
    struct Line: Equatable { let op: Character; let text: String } // " ", "-", "+"
    struct Hunk: Equatable { let header: String; let lines: [Line] }
    struct Result: Equatable { let hunks: [Hunk]; let added: Int; let removed: Int }

    static let maxCells = 4_000_000

    /// The line operations turning a into b.
    static func lines(_ a: [String], _ b: [String]) -> [Line] {
        var pre = 0
        while pre < a.count && pre < b.count && a[pre] == b[pre] { pre += 1 }
        var suf = 0
        while suf < a.count - pre && suf < b.count - pre && a[a.count - 1 - suf] == b[b.count - 1 - suf] { suf += 1 }
        let A = Array(a[pre..<(a.count - suf)]), B = Array(b[pre..<(b.count - suf)])
        var out = a[0..<pre].map { Line(op: " ", text: $0) }
        let n = A.count, m = B.count
        if n * m > maxCells {
            out += A.map { Line(op: "-", text: $0) } + B.map { Line(op: "+", text: $0) }
        } else {
            let w = m + 1
            var lcs = [UInt32](repeating: 0, count: (n + 1) * w)
            if n > 0 && m > 0 {
                for i in stride(from: n - 1, through: 0, by: -1) {
                    for j in stride(from: m - 1, through: 0, by: -1) {
                        lcs[i * w + j] = A[i] == B[j] ? lcs[(i + 1) * w + j + 1] + 1 : max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
                    }
                }
            }
            var i = 0, j = 0
            while i < n || j < m {
                if i < n && j < m && A[i] == B[j] { out.append(Line(op: " ", text: A[i])); i += 1; j += 1 }
                else if i < n && (j == m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) { out.append(Line(op: "-", text: A[i])); i += 1 } // removals first
                else { out.append(Line(op: "+", text: B[j])); j += 1 }
            }
        }
        out += a[(a.count - suf)...].map { Line(op: " ", text: $0) }
        return out
    }

    /// Unified hunks between two texts, with the added and removed line counts.
    static func unified(_ before: String, _ after: String, context: Int = 3) -> Result {
        func split(_ s: String) -> [String] {
            if s.isEmpty { return [] }
            var t = s
            if t.hasSuffix("\n") { t.removeLast() }
            return t.components(separatedBy: "\n")
        }
        let ops = lines(split(before), split(after))
        let added = ops.filter { $0.op == "+" }.count, removed = ops.filter { $0.op == "-" }.count
        var hunks: [Hunk] = []
        var k = 0
        while k < ops.count {
            while k < ops.count && ops[k].op == " " { k += 1 }
            if k >= ops.count { break }
            let start = max(0, k - context)
            var end = k
            var gap = 0
            while end < ops.count {
                if ops[end].op == " " { gap += 1; if gap > 2 * context { end -= gap - context; break } }
                else { gap = 0 }
                end += 1
            }
            end = min(end, ops.count)
            if end == ops.count {
                var tail = 0
                while tail < end - k && ops[end - 1 - tail].op == " " { tail += 1 }
                end -= max(0, tail - context)
            }
            var la = 1, lb = 1
            for q in 0..<start { if ops[q].op != "+" { la += 1 }; if ops[q].op != "-" { lb += 1 } }
            let slice = Array(ops[start..<end])
            let na = slice.filter { $0.op != "+" }.count, nb = slice.filter { $0.op != "-" }.count
            hunks.append(Hunk(header: "@@ -\(na > 0 ? la : la - 1),\(na) +\(nb > 0 ? lb : lb - 1),\(nb) @@", lines: slice))
            k = end
        }
        return Result(hunks: hunks, added: added, removed: removed)
    }
}
