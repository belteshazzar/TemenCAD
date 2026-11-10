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

/// The current project and conversation on disk, in Application Support (the app keeps one project for now).
enum ProjectStore {
    static var folder: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Current", isDirectory: true)
    }
    static var filesFolder: URL { folder.appendingPathComponent("files", isDirectory: true) }
    static var chatFile: URL { folder.appendingPathComponent("chat.json") }
    static var extrasFolder: URL { folder.appendingPathComponent("extras", isDirectory: true) }
    static var nameFile: URL { folder.appendingPathComponent("name.txt") }
    /// Photos attached in the conversation, full size: attachment n is attachments/n.jpg.
    static var attachmentsFolder: URL { folder.appendingPathComponent("attachments", isDirectory: true) }
    static func attachmentURL(_ n: Int) -> URL { attachmentsFolder.appendingPathComponent("\(n).jpg") }
    static func attachmentCount() -> Int {
        var n = 0
        while FileManager.default.fileExists(atPath: attachmentURL(n + 1).path) { n += 1 }
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
