// .temen project archives (a plain zip), read and written by the core (miniz), no TemenCore needed.
//
//     let project = try TemenArchive.readProject(data)       // files ready for TemenCore.build(files:)
//     let data = try TemenArchive.write(project.files.merging(project.extras) { a, _ in a })
import CTemenCore
import Foundation

public struct TemenArchiveError: Error, Sendable, CustomStringConvertible {
    public let message: String
    public var description: String { message }
}

public enum TemenArchive {
    /// A project read from a .temen: `files` with the web app's rules applied (paths normalized, junk and
    /// dotfiles dropped, main.js present), and `extras`, the app's own data under ".assistant/".
    public struct Project: Sendable {
        public var files: [String: Data]
        public var extras: [String: Data]
    }

    /// Reads a .temen project as the web app does (Project.fromZip).
    public static func readProject(_ data: Data) throws -> Project {
        let archive = try open(data, temen_project_read)
        defer { temen_archive_free(archive) }
        return Project(files: entries(archive, temen_archive_count, temen_archive_entry),
                       extras: entries(archive, temen_archive_extra_count, temen_archive_extra))
    }

    /// Every file in a zip, names exactly as stored (folders skipped).
    public static func read(_ data: Data) throws -> [String: Data] {
        let archive = try open(data, temen_archive_read)
        defer { temen_archive_free(archive) }
        return entries(archive, temen_archive_count, temen_archive_entry)
    }

    /// Writes `files` as a zip, deflated at `level` (0 stores, 9 is smallest), in name order.
    public static func write(_ files: [String: Data], level: Int = 6) throws -> Data {
        let names = files.keys.sorted()
        let datas = names.map { files[$0]! }
        var error: UnsafePointer<CChar>?
        var length = 0
        let buffer: UnsafeMutableRawPointer? = withPinned(datas) { pointers in
            let cNames = names.map { strdup($0)! }
            defer { cNames.forEach { free($0) } }
            let entries = (0..<names.count).map { TemenFile(name: UnsafePointer(cNames[$0]), data: pointers[$0].0, len: pointers[$0].1) }
            return entries.withUnsafeBufferPointer { temen_archive_write($0.baseAddress, $0.count, Int32(level), &length, &error) }
        }
        guard let buffer else { throw TemenArchiveError(message: error.map { String(cString: $0) } ?? "cannot write the archive") }
        defer { temen_buffer_free(buffer) }
        return Data(bytes: buffer, count: length)
    }

    private static func open(_ data: Data, _ reader: (UnsafeRawPointer?, Int, UnsafeMutablePointer<UnsafePointer<CChar>?>?) -> OpaquePointer?) throws -> OpaquePointer {
        var error: UnsafePointer<CChar>?
        let archive = data.withUnsafeBytes { raw in reader(raw.baseAddress, raw.count, &error) }
        guard let archive else { throw TemenArchiveError(message: error.map { String(cString: $0) } ?? "cannot read the archive") }
        return archive
    }

    private static func entries(_ archive: OpaquePointer, _ count: (OpaquePointer?) -> Int,
                                _ entry: (OpaquePointer?, Int) -> UnsafePointer<TemenFile>?) -> [String: Data] {
        var out: [String: Data] = [:]
        for i in 0..<count(archive) {
            guard let e = entry(archive, i)?.pointee else { continue }
            out[String(cString: e.name)] = e.len > 0 ? Data(bytes: e.data, count: e.len) : Data()
        }
        return out
    }

    /// Calls `body` with a stable (pointer, length) per Data, all pinned at once.
    private static func withPinned<R>(_ datas: [Data], _ body: ([(UnsafeRawPointer?, Int)]) -> R) -> R {
        func recurse(_ i: Int, _ acc: [(UnsafeRawPointer?, Int)]) -> R {
            if i == datas.count { return body(acc) }
            return datas[i].withUnsafeBytes { raw in recurse(i + 1, acc + [(raw.baseAddress, raw.count)]) }
        }
        return recurse(0, [])
    }
}
