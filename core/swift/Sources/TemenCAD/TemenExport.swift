// STL and 3MF from built parts, written by the core (byte for byte the web app's export), no TemenCore needed.
//
//     let printable = result.parts.filter { !$0.ghost && !$0.hidden }
//     let stl = try TemenExport.stl(printable)        // one binary solid, Z up
//     let threeMF = try TemenExport.threeMF(printable) // named, coloured objects, Z up
import CTemenCore
import Foundation

public enum TemenExport {
    /// Binary STL of every part given, as one solid. Coordinates are Z up, as slicers expect.
    public static func stl(_ parts: [TemenPart]) throws -> Data { try write(parts, temen_write_stl) }

    /// 3MF with each part a named object in its colour (what Prusa, Bambu, Orca and Cura read). Z up.
    public static func threeMF(_ parts: [TemenPart]) throws -> Data { try write(parts, temen_write_3mf) }

    private typealias Writer = (UnsafePointer<CTemenCore.TemenPart>?, Int, UnsafeMutablePointer<Int>?, UnsafeMutablePointer<UnsafePointer<CChar>?>?) -> UnsafeMutableRawPointer?

    private static func write(_ parts: [TemenPart], _ writer: Writer) throws -> Data {
        guard !parts.isEmpty else { throw TemenArchiveError(message: "Nothing to export: no visible, non-ghost parts") }
        var error: UnsafePointer<CChar>?
        var length = 0
        let buffer: UnsafeMutableRawPointer? = withCParts(parts) { cParts in
            cParts.withUnsafeBufferPointer { writer($0.baseAddress, $0.count, &length, &error) }
        }
        guard let buffer else { throw TemenArchiveError(message: error.map { String(cString: $0) } ?? "cannot write the file") }
        defer { temen_buffer_free(buffer) }
        return Data(bytes: buffer, count: length)
    }

    /// The C view of the parts, with every string and buffer pinned while `body` runs.
    private static func withCParts<R>(_ parts: [TemenPart], _ body: ([CTemenCore.TemenPart]) -> R) -> R {
        let names = parts.map { strdup($0.name)! }, colors = parts.map { strdup($0.color)! }
        defer { names.forEach { free($0) }; colors.forEach { free($0) } }
        func recurse(_ i: Int, _ acc: [CTemenCore.TemenPart]) -> R {
            if i == parts.count { return body(acc) }
            let p = parts[i]
            return p.positions.withUnsafeBufferPointer { pos in
                p.indices.withUnsafeBufferPointer { idx in
                    recurse(i + 1, acc + [CTemenCore.TemenPart(
                        name: UnsafePointer(names[i]), named: p.named ? 1 : 0, color: UnsafePointer(colors[i]),
                        ghost: p.ghost ? 1 : 0, hidden: p.hidden ? 1 : 0,
                        positions: pos.baseAddress, n_verts: p.positions.count / 3,
                        indices: idx.baseAddress, n_tris: p.indices.count / 3, volume: p.volume)])
                }
            }
        }
        return recurse(0, [])
    }
}
