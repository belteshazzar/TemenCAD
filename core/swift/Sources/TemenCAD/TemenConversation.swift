// The assistant conversation in a .temen (format 2, core/CONVERSATION.md), packed and read by the core.
//
//     let entries = try TemenConversation.pack(json: json, blobs: ["k1": main])   // into the archive
//     if let c = try TemenConversation.unpack(project.extras) { ... c.json, c.blobs }
import CTemenCore
import Foundation

public enum TemenConversation {
    /// The archive entries for a conversation: ".assistant/conversation.json" and ".assistant/blobs/<sha256>".
    /// `json` is the format-2 document with base64 sources inline and {"$blob": key} references to `blobs`
    /// (keys are the app's own); throws with the core's reason when the document or a reference is wrong.
    public static func pack(json: Data, blobs: [String: Data] = [:]) throws -> [String: Data] {
        // the core reads the blobs during the call; copies keep the pointers simple
        let keys = blobs.keys.map { strdup($0)! }
        let copies: [UnsafeMutableRawPointer] = blobs.values.map { d in
            let p = malloc(max(d.count, 1))!
            d.copyBytes(to: p.assumingMemoryBound(to: UInt8.self), count: d.count)
            return p
        }
        defer { keys.forEach { free($0) }; copies.forEach { free($0) } }
        let counts = blobs.values.map(\.count)
        let cBlobs = (0..<keys.count).map { TemenBlob(key: UnsafePointer(keys[$0]), data: UnsafeRawPointer(copies[$0]), len: counts[$0]) }
        var n = 0
        var error: UnsafeMutablePointer<CChar>?
        let files = json.withUnsafeBytes { raw in
            cBlobs.withUnsafeBufferPointer { b in
                temen_conversation_pack(raw.baseAddress?.assumingMemoryBound(to: CChar.self), raw.count, b.baseAddress, b.count, &n, &error)
            }
        }
        guard let files else { throw failure(error, "cannot pack the conversation") }
        defer { temen_files_free(files, n) }
        var out: [String: Data] = [:]
        for i in 0..<n { out[String(cString: files[i].name)] = Data(bytes: files[i].data, count: files[i].len) }
        return out
    }

    /// The conversation in a project's entries (the ".assistant/" extras are enough), or nil when there is
    /// none: the JSON with base64 sources inline and references by SHA-256, and those references' bytes.
    /// Throws when it cannot be read (another format, a missing or damaged blob).
    public static func unpack(_ entries: [String: Data]) throws -> (json: Data, blobs: [String: Data])? {
        let mine = entries.filter { $0.key.hasPrefix(".assistant/") }
        let names = mine.keys.map { strdup($0)! }
        let copies: [UnsafeMutableRawPointer] = mine.values.map { d in
            let p = malloc(max(d.count, 1))!
            d.copyBytes(to: p.assumingMemoryBound(to: UInt8.self), count: d.count)
            return p
        }
        defer { names.forEach { free($0) }; copies.forEach { free($0) } }
        let counts = mine.values.map(\.count)
        let files = (0..<names.count).map { TemenFile(name: UnsafePointer(names[$0]), data: UnsafeRawPointer(copies[$0]), len: counts[$0]) }
        var error: UnsafeMutablePointer<CChar>?
        let conv = files.withUnsafeBufferPointer { temen_conversation_unpack($0.baseAddress, $0.count, &error) }
        guard let conv else {
            if error != nil { throw failure(error, "cannot read the conversation") }
            return nil
        }
        defer { temen_conversation_free(conv) }
        var len = 0
        let text = temen_conversation_json(conv, &len)!
        var blobs: [String: Data] = [:]
        for i in 0..<temen_conversation_blob_count(conv) {
            let b = temen_conversation_blob(conv, i)!.pointee
            blobs[String(cString: b.key)] = Data(bytes: b.data, count: b.len)
        }
        return (Data(bytes: text, count: len), blobs)
    }

    private static func failure(_ error: UnsafeMutablePointer<CChar>?, _ fallback: String) -> TemenArchiveError {
        defer { temen_buffer_free(error) }
        return TemenArchiveError(message: error.map { String(cString: $0) } ?? fallback)
    }
}
