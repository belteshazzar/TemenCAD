import CryptoKit
import Foundation

/// The project's files at moments in the conversation (before and after each reply that changed them, and
/// before each undo), so a reply can be undone and the undo put back. A checkpoint is a map from file name
/// to the SHA-256 of its bytes; the bytes are stored once each in Current/blobs, so a photo or font that
/// every checkpoint contains takes its size once. A new chat clears them.
struct Checkpoints {
    private(set) var list: [[String: String]] = []

    static var folder: URL { ProjectStore.folder.appendingPathComponent("blobs", isDirectory: true) }

    /// Keeps the project's files as a new checkpoint and returns its index.
    mutating func add(_ files: [String: Data]) -> Int {
        try? FileManager.default.createDirectory(at: Self.folder, withIntermediateDirectories: true)
        var entry: [String: String] = [:]
        for (name, data) in files {
            let key = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            let url = Self.folder.appendingPathComponent(key)
            if !FileManager.default.fileExists(atPath: url.path) { try? data.write(to: url, options: .atomic) }
            entry[name] = key
        }
        list.append(entry)
        return list.count - 1
    }

    /// The files of checkpoint `index`, or nil when it is missing or a blob is gone.
    func files(_ index: Int) -> [String: Data]? {
        guard list.indices.contains(index) else { return nil }
        var files: [String: Data] = [:]
        for (name, key) in list[index] {
            guard let d = try? Data(contentsOf: Self.folder.appendingPathComponent(key)) else { return nil }
            files[name] = d
        }
        return files
    }

    /// Is checkpoint `index` exactly these files?
    func matches(_ index: Int, _ files: [String: Data]) -> Bool {
        guard list.indices.contains(index), list[index].count == files.count else { return false }
        return files.allSatisfy { name, data in list[index][name] == SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    }

    /// What changed from checkpoint a to checkpoint b, file by file (names in order).
    func changes(from a: Int, to b: Int) -> [FileChange] {
        guard list.indices.contains(a), list.indices.contains(b) else { return [] }
        let x = list[a], y = list[b]
        var out: [FileChange] = []
        for name in Set(x.keys).union(y.keys).sorted() where x[name] != y[name] {
            let status: FileChange.Status = x[name] == nil ? .added : y[name] == nil ? .removed : .changed
            let load = { (key: String?) in key.flatMap { try? Data(contentsOf: Self.folder.appendingPathComponent($0)) } }
            let before = load(x[name]), after = load(y[name])
            if Project.isText(name) {
                let diff = Diff.unified(before.map { String(decoding: $0, as: UTF8.self) } ?? "", after.map { String(decoding: $0, as: UTF8.self) } ?? "")
                out.append(FileChange(name: name, status: status, diff: diff, size: nil))
            } else {
                out.append(FileChange(name: name, status: status, diff: nil, size: (after ?? before)?.count))
            }
        }
        return out
    }

    /// Restores the list kept with the conversation.
    mutating func restore(_ saved: [[String: String]]) { list = saved }

    /// Drops every checkpoint and its blobs (a new chat).
    mutating func clear() {
        list = []
        try? FileManager.default.removeItem(at: Self.folder)
    }
}

/// One file's change between two checkpoints: a line diff for text, a size for anything else.
struct FileChange: Identifiable {
    enum Status: String { case added, removed, changed }
    let name: String
    let status: Status
    let diff: Diff.Result?
    let size: Int?
    var id: String { name }

    /// "main.js +3 −1", or "photo.jpg added", as the web app summarises a reply.
    var summary: String {
        if let d = diff, status == .changed { return "\(name) +\(d.added) −\(d.removed)" }
        return "\(name) \(status.rawValue)"
    }
}
