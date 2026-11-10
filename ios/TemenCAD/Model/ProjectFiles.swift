import Foundation

/// The project's file rules, as the web app has them (src/project.js and the file tabs in src/tabs.js):
/// which files a project takes, names, and what a binary file is for.
extension Project {
    static let fontExtensions = ["ttf", "otf"]
    static let meshExtensions = ["stl"]
    static let imageExtensions = ["png", "jpg", "jpeg"]
    static var acceptedExtensions: [String] { textExtensions + fontExtensions + meshExtensions + imageExtensions }

    static func ext(_ name: String) -> String { (name as NSString).pathExtension.lowercased() }
    static func isScript(_ name: String) -> Bool { ["js", "mjs"].contains(ext(name)) }

    /// A project-relative path: forward slashes, no "./" or leading "/", no ".." above the root; nil if empty.
    static func normalizePath(_ path: String) -> String? {
        var out: [Substring] = []
        for seg in path.replacingOccurrences(of: "\\", with: "/").split(separator: "/", omittingEmptySubsequences: true) {
            if seg == "." { continue }
            if seg == ".." { if out.isEmpty { return nil }; out.removeLast() } else { out.append(seg) }
        }
        return out.isEmpty ? nil : out.joined(separator: "/")
    }

    enum NameCheck { case ok(String), error(String) }

    /// A name for a new or renamed text file (the web app's checkScriptName): ".js" added when there is no
    /// extension, a type the project takes, not main.js, not taken, and a rename keeps the kind of file.
    func checkScriptName(_ raw: String, current: String? = nil) -> NameCheck {
        let name = raw.trimmingCharacters(in: .whitespaces)
        if name.isEmpty { return .error("Enter a file name.") }
        guard let n = Self.normalizePath(name.contains(".") ? name : name + ".js") else { return .error("That is not a valid file name.") }
        if !Self.acceptedExtensions.contains(Self.ext(n)) {
            return .error("Unsupported file type \".\(Self.ext(n))\". Use \(Self.acceptedExtensions.map { "." + $0 }.joined(separator: ", ")).")
        }
        if n == Self.entry { return .error("\(Self.entry) is the entry script.") }
        if n != current && files[n] != nil { return .error("\"\(n)\" already exists.") }
        if let current, Self.isText(current) != Self.isText(n) { return .error("Keep the same kind of file extension.") }
        return .ok(n)
    }

    /// A rename (the web app's rules): text files as checkScriptName, binary files keep their extension.
    func checkRename(_ from: String, to raw: String) -> NameCheck {
        if Self.isText(from) { return checkScriptName(raw, current: from) }
        guard let n = Self.normalizePath(raw.trimmingCharacters(in: .whitespaces)), Self.ext(n) == Self.ext(from) else {
            return .error("Keep the .\(Self.ext(from)) extension.")
        }
        if n != from && files[n] != nil { return .error("\"\(n)\" already exists.") }
        return .ok(n)
    }

    /// `name`, or name-2, name-3… when it is taken.
    func uniqueName(_ name: String) -> String {
        guard files[name] != nil else { return name }
        let ext = (name as NSString).pathExtension, stem = (name as NSString).deletingPathExtension
        return (2...).lazy.map { "\(stem)-\($0)\(ext.isEmpty ? "" : "." + ext)" }.first { files[$0] == nil }!
    }

    /// What kind of file it is, for the list ("Script", "Mesh (STL)"…).
    static func kind(_ name: String) -> String {
        switch ext(name) {
        case "js", "mjs": return "Script"
        case "svg": return "SVG drawing"
        case "json": return "JSON"
        case "ttf", "otf": return "Font"
        case "stl": return "Mesh (STL)"
        case "png", "jpg", "jpeg": return "Image"
        default: return "Text"
        }
    }

    /// How a script uses a binary file (the web app's asset panel).
    static func usage(_ name: String) -> String {
        var ident = ((name as NSString).deletingPathExtension).replacingOccurrences(of: "[^A-Za-z0-9_$]+", with: "_", options: .regularExpression)
        if ident.first?.isNumber == true { ident = "_" + ident }
        let line = "import \(ident) from './\(name)';"
        switch ext(name) {
        case "ttf", "otf": return "\(line)\ntext3d('Hi', { font: \(ident) })"
        case "stl": return "\(line)\nreturn \(ident).onPlate();"
        case "png", "jpg", "jpeg": return "\(line)\nreturn lithophane(\(ident), { width: 80, upright: true });\n// or a relief: heightmap(\(ident), { width: 60, height: 4 })"
        default: return line
        }
    }
}
