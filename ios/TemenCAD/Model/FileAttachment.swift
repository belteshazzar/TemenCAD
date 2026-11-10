import Foundation

/// A file attached to a message that is not a photo: a PDF shown to the assistant (a drawing, a datasheet,
/// a manual), or a file added to the project with the message (an STL to fit against, an SVG outline, a font,
/// a script). The same split as the web app's (src/attachments.js); photos are PhotoAttachment.
struct FileAttachment: Identifiable, Equatable {
    enum Kind: Equatable { case pdf, project }
    let id = UUID()
    let name: String
    let data: Data
    let kind: Kind

    /// A request may be 32 MB in all, so a PDF may be up to 30 MB (as on the web).
    static let maxPDFBytes = 30 * 1024 * 1024
    /// Files the project takes (src/project.js ACCEPTED_EXT, less the images, which go to the assistant as photos).
    static let projectExtensions = ["js", "mjs", "json", "txt", "md", "svg", "ttf", "otf", "stl"]
    /// Images the project takes as they are (heightmap, lithophane): what add_files keeps byte for byte.
    static let projectImageExtensions = ["png", "jpg", "jpeg"]
    /// Images the assistant can be shown (anything UIImage reads, the usual ones named for the error message).
    static let photoExtensions = ["png", "jpg", "jpeg", "heic", "heif", "webp", "gif", "tif", "tiff", "bmp"]

    enum Classified { case photo, file(FileAttachment), error(String) }

    /// What a file the user attached is: a photo, a PDF or a project file; an error says what can be attached.
    static func classify(name: String, data: Data) -> Classified {
        let ext = (name as NSString).pathExtension.lowercased()
        if photoExtensions.contains(ext) { return .photo }
        if ext == "pdf" || data.starts(with: Data("%PDF-".utf8)) {
            if data.count > maxPDFBytes { return .error("\(name) is over 30 MB; the API takes up to 32 MB per message.") }
            return .file(FileAttachment(name: name, data: data, kind: .pdf))
        }
        if projectExtensions.contains(ext) { return .file(FileAttachment(name: name, data: data, kind: .project)) }
        return .error("\(name): attach photos or PDFs to show the assistant, or \(projectExtensions.map { "." + $0 }.joined(separator: ", ")) files to add to the project.")
    }

    /// The name as a project path: no folders, nothing hidden; nil when nothing usable is left.
    static func projectName(_ name: String) -> String? {
        let base = (name.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
            .trimmingCharacters(in: .whitespaces)
        guard !base.isEmpty, !base.hasPrefix(".") else { return nil }
        return base
    }

    var extensionLabel: String { String((name as NSString).pathExtension.uppercased().prefix(4)) }
    var sizeLabel: String { ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file) }
}

/// A card in the chat that the assistant waits on: add_files, open_project, save_project.
struct ChatRequest: Equatable {
    enum Kind: Equatable { case addFiles, open, saveAs }
    var kind: Kind
    var reason: String

    var buttonLabel: String {
        switch kind { case .addFiles: "Add files…"; case .open: "Open…"; case .saveAs: "Save as…" }
    }
    var systemImage: String {
        switch kind { case .addFiles: "folder.badge.plus"; case .open: "doc"; case .saveAs: "square.and.arrow.down" }
    }
}

/// The user's answer to a card: the files they picked (add_files) or the file opened or saved.
enum RequestAnswer {
    case files([(name: String, data: Data)])
    case url(URL)
}
