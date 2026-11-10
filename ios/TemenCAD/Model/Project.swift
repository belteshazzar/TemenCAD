import CryptoKit
import Foundation
import TemenCAD
import UniformTypeIdentifiers

extension UTType {
    /// A .temen project: a zip of the project's files (declared in Info.plist).
    static let temenProject = UTType(exportedAs: "com.temencad.project", conformingTo: .zip)
}

/// A project: named files (main.js is the entry; other scripts, fonts, meshes, images), as in the web app.
struct Project: Equatable {
    var files: [String: Data]
    /// What it is called: the .temen file name it came from or is saved as, without the extension.
    var name = "Model"
    /// Entries under .assistant/ in the .temen it came from (the web app's conversation), written back
    /// unchanged when the project is saved so a round trip through the phone does not lose them.
    var extras: [String: Data] = [:]

    static let entry = "main.js"
    static let textExtensions = ["js", "mjs", "json", "txt", "md", "svg"]
    static func isText(_ name: String) -> Bool { textExtensions.contains((name as NSString).pathExtension.lowercased()) }

    static let starter = Project(files: [entry: Data("""
    // A TemenCAD model is a script: describe what you want in the chat and the assistant writes it.
    // Units are mm, Y is up, and the build plate is y = 0.
    return roundedBox(40, 12, 30, 2).onPlate().name('block');

    """.utf8)])

    func text(_ name: String) -> String? {
        guard Self.isText(name), let d = files[name] else { return nil }
        return String(decoding: d, as: UTF8.self)
    }
    var names: [String] { files.keys.sorted { $0 == Self.entry ? true : $1 == Self.entry ? false : $0 < $1 } }

    /// Reads a .temen with the web app's rules (in the core: temen_project_read).
    init(temen data: Data, name: String) throws {
        let read = try TemenArchive.readProject(data)
        self.init(files: read.files, name: name, extras: read.extras)
    }
    init(files: [String: Data], name: String = "Model", extras: [String: Data] = [:]) {
        self.files = files
        self.name = name
        self.extras = extras
    }

    /// The .temen archive bytes, as the web app writes them.
    func temen() throws -> Data { try TemenArchive.write(files.merging(extras) { file, _ in file }) }

    /// The project's name as a file name (characters Files does not like replaced), without an extension.
    var fileStem: String {
        let cleaned = name.components(separatedBy: CharacterSet(charactersIn: "/\\:?%*|\"<>")).joined(separator: "-").trimmingCharacters(in: .whitespaces)
        return cleaned.isEmpty ? "Model" : cleaned
    }
    var fileName: String { fileStem + ".temen" }
}

/// An open project: its own folder (files, conversation, undo points, attachments) and the .temen file it
/// is saved to, if any.
struct WorkspaceInfo: Codable, Identifiable, Equatable {
    var id = UUID()
    var name: String
    /// A bookmark to the .temen on the user's device (Files: iCloud Drive, On My iPhone, a provider), so Save
    /// writes it in place; nil for a project never saved.
    var bookmark: Data?
    /// ProjectStore.digest of the project when it was last opened or saved: differs once it has unsaved changes.
    var savedDigest: String
    /// The file's modification date when it was last read or written, to notice another app or device changing it.
    var fileDate: Date?
    /// Whether it had unsaved changes when last shown (for the project menu's marker).
    var unsaved: Bool?
    /// The conversation's revision when it was last opened or saved (it is saved in the file too).
    var savedChatRevision: Int?
}

/// A .temen closed recently, for Open Recent.
struct RecentFile: Codable, Equatable {
    var name: String
    var bookmark: Data
}

/// The open projects, which one is showing, and the recent files: Workspaces/index.json.
struct WorkspaceIndex: Codable {
    var open: [WorkspaceInfo] = []
    var current: UUID?
    var recent: [RecentFile] = []
}

/// The projects on disk, in Application Support: Workspaces/<id>/ for each open project (the one showing
/// is `folder`), and Workspaces/index.json.
enum ProjectStore {
    static var root: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Workspaces", isDirectory: true)
    }
    static var indexFile: URL { root.appendingPathComponent("index.json") }
    /// The project showing: everything below (files, chat, attachments, blobs, exports) is relative to it.
    static var currentID = UUID()
    static func folder(_ id: UUID) -> URL { root.appendingPathComponent(id.uuidString, isDirectory: true) }
    static var folder: URL { folder(currentID) }

    static func loadIndex() -> WorkspaceIndex {
        if let d = try? Data(contentsOf: indexFile), let index = try? JSONDecoder().decode(WorkspaceIndex.self, from: d) { return index }
        // the single project of earlier versions (Application Support/Current) becomes the first workspace
        var index = WorkspaceIndex()
        let old = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Current", isDirectory: true)
        if FileManager.default.fileExists(atPath: old.appendingPathComponent("files/\(Project.entry)").path) {
            let info = WorkspaceInfo(name: (try? String(contentsOf: old.appendingPathComponent("name.txt"), encoding: .utf8)) ?? "Model", savedDigest: "")
            try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            if (try? FileManager.default.moveItem(at: old, to: folder(info.id))) != nil {
                index.open = [info]
                index.current = info.id
            }
        }
        return index
    }

    static func saveIndex(_ index: WorkspaceIndex) {
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try? JSONEncoder().encode(index).write(to: indexFile, options: .atomic)
    }

    static func remove(_ id: UUID) { try? FileManager.default.removeItem(at: folder(id)) }

    /// Copies the conversation's files (attachments, undo blobs, exports) to another workspace, when the
    /// conversation carries on there (the assistant opened or started a project).
    static func copyConversation(from a: UUID, to b: UUID) {
        let fm = FileManager.default
        for sub in ["attachments", "blobs", "exports"] {
            let src = folder(a).appendingPathComponent(sub), dst = folder(b).appendingPathComponent(sub)
            guard fm.fileExists(atPath: src.path) else { continue }
            try? fm.removeItem(at: dst)
            try? fm.createDirectory(at: folder(b), withIntermediateDirectories: true)
            try? fm.copyItem(at: src, to: dst)
        }
    }

    /// A fingerprint of the project's contents (files and kept extras), for the unsaved marker.
    static func digest(_ p: Project) -> String {
        var h = SHA256()
        for (prefix, files) in [("f:", p.files), ("x:", p.extras)] {
            for name in files.keys.sorted() {
                h.update(data: Data((prefix + name + "\u{0}").utf8))
                h.update(data: Data(SHA256.hash(data: files[name]!)))
            }
        }
        return h.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static var filesFolder: URL { folder.appendingPathComponent("files", isDirectory: true) }
    static var chatFile: URL { folder.appendingPathComponent("chat.json") }
    static var extrasFolder: URL { folder.appendingPathComponent("extras", isDirectory: true) }
    static var nameFile: URL { folder.appendingPathComponent("name.txt") }
    /// Photos and PDFs attached in the conversation, full size: attachment n is attachments/n.jpg or n.pdf.
    static var attachmentsFolder: URL { folder.appendingPathComponent("attachments", isDirectory: true) }
    static let attachmentExtensions = ["jpg", "pdf"]
    static func attachmentURL(_ n: Int, ext: String) -> URL { attachmentsFolder.appendingPathComponent("\(n).\(ext)") }
    /// Attachment n on disk, with its extension; nil when there is none.
    static func attachment(_ n: Int) -> (url: URL, ext: String)? {
        for ext in attachmentExtensions {
            let url = attachmentURL(n, ext: ext)
            if FileManager.default.fileExists(atPath: url.path) { return (url, ext) }
        }
        return nil
    }
    /// The names attachments were sent with (attachments/names.json, by number).
    static func attachmentNames() -> [Int: String] {
        guard let d = try? Data(contentsOf: attachmentsFolder.appendingPathComponent("names.json")),
              let m = try? JSONDecoder().decode([String: String].self, from: d) else { return [:] }
        return Dictionary(uniqueKeysWithValues: m.compactMap { k, v in Int(k).map { ($0, v) } })
    }
    static func setAttachmentNames(_ names: [Int: String]) {
        try? FileManager.default.createDirectory(at: attachmentsFolder, withIntermediateDirectories: true)
        let m = Dictionary(uniqueKeysWithValues: names.map { (String($0.key), $0.value) })
        try? JSONEncoder().encode(m).write(to: attachmentsFolder.appendingPathComponent("names.json"), options: .atomic)
    }
    static func attachmentCount() -> Int {
        var n = 0
        while attachment(n + 1) != nil { n += 1 }
        return n
    }

    static func load() -> Project {
        let files = readTree(filesFolder)
        guard files[Project.entry] != nil else { return .starter }
        let name = (try? String(contentsOf: nameFile, encoding: .utf8)).flatMap { $0.isEmpty ? nil : $0 } ?? "Model"
        return Project(files: files, name: name, extras: readTree(extrasFolder))
    }

    static func save(_ project: Project) {
        writeTree(project.files, to: filesFolder)
        writeTree(project.extras, to: extrasFolder)
        try? project.name.write(to: nameFile, atomically: true, encoding: .utf8)
    }

    private static func readTree(_ root: URL) -> [String: Data] {
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else { return [:] }
        var files: [String: Data] = [:]
        let prefix = root.standardizedFileURL.path + "/"
        for case let url as URL in enumerator where (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
            files[String(url.standardizedFileURL.path.dropFirst(prefix.count))] = try? Data(contentsOf: url)
        }
        return files
    }

    private static func writeTree(_ files: [String: Data], to root: URL) {
        let fm = FileManager.default
        try? fm.removeItem(at: root)
        try? fm.createDirectory(at: root, withIntermediateDirectories: true)
        for (name, data) in files {
            let url = root.appendingPathComponent(name)
            try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }
}
