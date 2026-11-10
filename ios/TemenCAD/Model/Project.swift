import Foundation

/// A project: named files (main.js is the entry; other scripts, fonts, meshes, images), as in the web app.
struct Project: Equatable {
    var files: [String: Data]

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
}

/// The current project and conversation on disk, in Application Support (the app keeps one project for now).
enum ProjectStore {
    static var folder: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Current", isDirectory: true)
    }
    static var filesFolder: URL { folder.appendingPathComponent("files", isDirectory: true) }
    static var chatFile: URL { folder.appendingPathComponent("chat.json") }

    static func load() -> Project {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: filesFolder, includingPropertiesForKeys: [.isRegularFileKey]) else { return .starter }
        var files: [String: Data] = [:]
        let root = filesFolder.standardizedFileURL.path + "/"
        for case let url as URL in enumerator where (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
            let name = String(url.standardizedFileURL.path.dropFirst(root.count))
            files[name] = try? Data(contentsOf: url)
        }
        return files[Project.entry] == nil ? .starter : Project(files: files)
    }

    static func save(_ project: Project) {
        let fm = FileManager.default
        try? fm.removeItem(at: filesFolder)
        for (name, data) in project.files {
            let url = filesFolder.appendingPathComponent(name)
            try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }
}
