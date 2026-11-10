import Foundation
import SwiftUI
import UIKit
import TemenCAD

/// One line of the conversation as the user sees it.
struct ChatEntry: Identifiable, Codable, Equatable {
    enum Kind: String, Codable { case user, assistant, tool, image, error, status }
    var id = UUID()
    var kind: Kind
    var text: String
    var image: Data? = nil
    /// Thumbnails of the photos attached to a user message.
    var photos: [Data]? = nil
}

/// The app: the project, its builds, the preview and the conversation. Kept on the main actor.
@MainActor
final class AppModel: ObservableObject, AgentHost {
    @Published var project: Project { didSet { ProjectStore.save(project) } }
    @Published private(set) var entries: [ChatEntry] = []
    @Published private(set) var busy = false
    @Published private(set) var buildStatus = ""
    /// The visible, non-ghost parts of the last successful build: what STL and 3MF export write.
    @Published private(set) var printableParts: [TemenPart] = []
    /// A file waiting in the share sheet.
    @Published var sharing: SharedFile?
    /// Photos waiting to go with the next message.
    @Published var pendingPhotos: [PhotoAttachment] = []
    static let maxPhotosPerMessage = 5
    @Published var apiKey: String { didSet { Keychain.write(apiKey); agent.client.apiKey = apiKey } }
    @Published var model: String { didSet { UserDefaults.standard.set(model, forKey: "model"); agent.model = model } }

    let preview = PreviewController()
    private let builder = ModelBuilder()
    private let agent: Agent
    private(set) var lastReport: JSONValue?
    private var task: Task<Void, Never>?

    init() {
        let key = Keychain.read() ?? ""
        var client = AnthropicClient(apiKey: key)
        #if DEBUG
        // Development: point the app at a local stand-in API (see ios/README.md)
        if let base = UserDefaults.standard.string(forKey: "TemenAPIBase"), let url = URL(string: base) { client.baseURL = url }
        #endif
        agent = Agent(client: client)
        apiKey = key
        model = UserDefaults.standard.string(forKey: "model") ?? Agent.defaultModel
        project = ProjectStore.load()
        agent.host = self
        agent.model = model
        #if DEBUG
        if let k = UserDefaults.standard.string(forKey: "TemenAPIKey") { apiKey = k }
        #endif
        loadChat()
        Task { await rebuild() }
    }

    // MARK: - Builds

    @discardableResult
    func rebuild() async -> TemenBuildResult? {
        let result = await builder.build(project)
        lastReport = BuildReport.make(result)
        buildStatus = BuildReport.summary(result)
        preview.show(result)
        printableParts = result?.ok == true ? result!.parts.filter { !$0.ghost && !$0.hidden } : []
        return result
    }

    func buildForAgent() async -> JSONValue {
        await rebuild()
        return lastReport ?? ["ok": false]
    }

    func screenshotForAgent(view: String?) -> Data? {
        guard let png = preview.snapshot(view: view) else { return nil }
        entries.append(ChatEntry(kind: .image, text: "Screenshot, \(view ?? "current") view", image: png))
        return png
    }

    // MARK: - Chat

    var hasKey: Bool { !apiKey.isEmpty }

    var canSend: Bool { !busy && hasKey }

    func send(_ text: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let photos = pendingPhotos
        guard !text.isEmpty || !photos.isEmpty, !busy, hasKey else { return }
        // each photo: kept full size as attachment n, shown to the model downscaled with its label
        var blocks: [JSONValue] = []
        for photo in photos {
            let n = ProjectStore.attachmentCount() + 1
            do {
                try FileManager.default.createDirectory(at: ProjectStore.attachmentsFolder, withIntermediateDirectories: true)
                try photo.original.write(to: ProjectStore.attachmentURL(n), options: .atomic)
            } catch {
                entries.append(ChatEntry(kind: .error, text: "Could not keep the photo: \(error.localizedDescription)"))
                return
            }
            blocks.append(["type": "text", "text": .string("Attachment \(n): photo (image, \(photo.sizeLabel))")])
            blocks.append(["type": "image", "source": ["type": "base64", "media_type": "image/jpeg", "data": .string(photo.shown.base64EncodedString())]])
        }
        pendingPhotos = []
        let message = text.isEmpty ? (photos.count == 1 ? "(a photo)" : "(\(photos.count) photos)") : text
        entries.append(ChatEntry(kind: .user, text: text, photos: photos.isEmpty ? nil : photos.map(\.thumbnail)))
        busy = true
        task = Task {
            var replyIndex: Int?
            do {
                try await agent.send(message, extra: blocks) { [weak self] event in
                    guard let self else { return }
                    switch event {
                    case .text(let t):
                        if let i = replyIndex, i < self.entries.count { self.entries[i].text += t }
                        else { self.entries.append(ChatEntry(kind: .assistant, text: t)); replyIndex = self.entries.count - 1 }
                    case .tool(let name):
                        replyIndex = nil
                        self.entries.append(ChatEntry(kind: .tool, text: Self.toolLabels[name] ?? name))
                    case .refusal:
                        self.entries.append(ChatEntry(kind: .error, text: "The model declined this request."))
                    case .done: break
                    }
                }
            } catch is CancellationError {
                entries.append(ChatEntry(kind: .status, text: "Stopped."))
            } catch let e as URLError where e.code == .cancelled {
                entries.append(ChatEntry(kind: .status, text: "Stopped."))
            } catch {
                entries.append(ChatEntry(kind: .error, text: error.localizedDescription))
            }
            busy = false
            saveChat()
        }
    }

    func stop() { task?.cancel() }

    func newChat() {
        stop()
        agent.reset()
        entries = []
        pendingPhotos = []
        try? FileManager.default.removeItem(at: ProjectStore.attachmentsFolder) // attachment numbers start again
        saveChat()
    }

    /// Start over with the starter model (the conversation is cleared too).
    func newProject() {
        newChat()
        project = .starter
        Task { await rebuild(); preview.frame(view: "iso") }
    }

    // MARK: - Photos

    func attachment(_ n: Int) -> Data? { n >= 1 ? try? Data(contentsOf: ProjectStore.attachmentURL(n)) : nil }
    var attachmentCount: Int { ProjectStore.attachmentCount() }

    /// Adds photos to the next message (at most five per message); false for data that is not an image.
    @discardableResult
    func attach(imageData: [Data]) -> Bool {
        var ok = true
        for d in imageData {
            guard pendingPhotos.count < Self.maxPhotosPerMessage else { break }
            if let p = PhotoAttachment(imageData: d) { pendingPhotos.append(p) } else { ok = false }
        }
        if !ok { entries.append(ChatEntry(kind: .error, text: "That file is not a photo the app can read.")) }
        return ok
    }

    func attach(image: UIImage) {
        guard pendingPhotos.count < Self.maxPhotosPerMessage, let p = PhotoAttachment(image: image) else { return }
        pendingPhotos.append(p)
    }

    // MARK: - STL and 3MF

    enum ExportFormat: String { case stl, threeMF = "3mf" }
    var canExport: Bool { !printableParts.isEmpty }

    /// Writes the model as STL or 3MF (the core's writers, the same bytes as the web app's) and opens the
    /// share sheet: a slicer app, AirDrop to a Mac, Save to Files, Mail.
    func share(_ format: ExportFormat) {
        do {
            let data = format == .stl ? try TemenExport.stl(printableParts) : try TemenExport.threeMF(printableParts)
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Export", isDirectory: true)
            try? FileManager.default.removeItem(at: folder) // only the latest export is kept
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appendingPathComponent("\(project.fileStem).\(format.rawValue)")
            try data.write(to: url, options: .atomic)
            sharing = SharedFile(url: url)
        } catch {
            entries.append(ChatEntry(kind: .error, text: "Could not export \(format == .stl ? "STL" : "3MF"): \(error)"))
        }
    }

    // MARK: - .temen files

    /// Opens a .temen (from the Files picker, AirDrop or "Open in"): it replaces the current model and
    /// starts a new conversation. A conversation the web app kept in the file is not shown here (the two
    /// apps keep conversations differently) but is kept and written back when the project is saved.
    func open(url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let opened = try Project(temen: try Data(contentsOf: url), name: url.deletingPathExtension().lastPathComponent)
            newChat()
            project = opened
            let kept = opened.extras.isEmpty ? "" : " The conversation saved with it in the web app is kept in the file but not shown here."
            entries.append(ChatEntry(kind: .status, text: "Opened \(url.lastPathComponent).\(kept)"))
            saveChat()
            Task { await rebuild(); preview.frame(view: "iso") }
        } catch {
            entries.append(ChatEntry(kind: .error, text: "Could not open \(url.lastPathComponent): \(error)"))
        }
    }

    /// The project as a .temen document for the save sheet, or nil (with the reason in the chat).
    func temenDocument() -> TemenDocument? {
        do { return TemenDocument(data: try project.temen()) }
        catch { entries.append(ChatEntry(kind: .error, text: "Could not save the project: \(error)")); return nil }
    }

    /// After a save: the project takes the saved file's name.
    func saved(to url: URL) {
        project.name = url.deletingPathExtension().lastPathComponent
        entries.append(ChatEntry(kind: .status, text: "Saved \(url.lastPathComponent)."))
        saveChat()
    }

    static let toolLabels = [
        "read_script": "Reading the script", "edit_script": "Editing the script", "write_script": "Writing the script",
        "remove_file": "Removing a file", "run_model": "Building the model", "take_screenshot": "Taking a screenshot",
        "save_attachment": "Adding the photo to the project",
    ]

    // MARK: - Keeping the conversation

    private struct SavedChat: Codable { var entries: [ChatEntry]; var messages: [JSONValue] }

    private func saveChat() {
        let saved = SavedChat(entries: entries, messages: agent.messages)
        try? FileManager.default.createDirectory(at: ProjectStore.folder, withIntermediateDirectories: true)
        try? JSONEncoder().encode(saved).write(to: ProjectStore.chatFile, options: .atomic)
    }

    private func loadChat() {
        guard let d = try? Data(contentsOf: ProjectStore.chatFile), let saved = try? JSONDecoder().decode(SavedChat.self, from: d) else { return }
        entries = saved.entries
        agent.restore(saved.messages)
    }

    #if DEBUG
    /// Development: send a prompt at launch (`-TemenAutoPrompt "make a box"`), for driving the app in the simulator.
    /// Also `-TemenOpen /path/a.temen` opens a project and `-TemenSaveTo /path/b.temen` writes the
    /// project there, so .temen handling can be checked without the system file sheets; `-TemenShare stl`
    /// (or 3mf) exports and opens the share sheet; `-TemenAttach /path/photo.jpg` attaches a photo to the next
    /// message (with -TemenAutoPrompt, sends it).
    func runAutoPrompt() {
        let defaults = UserDefaults.standard
        if let path = defaults.string(forKey: "TemenOpen"), !path.isEmpty { open(url: URL(fileURLWithPath: path)) }
        if let path = defaults.string(forKey: "TemenSaveTo"), !path.isEmpty {
            let url = URL(fileURLWithPath: path)
            if let doc = temenDocument() {
                do { try doc.data.write(to: url); saved(to: url) }
                catch { entries.append(ChatEntry(kind: .error, text: "Could not save the project: \(error)")) }
            }
        }
        if let f = defaults.string(forKey: "TemenShare"), let format = ExportFormat(rawValue: f) {
            Task { await rebuild(); share(format) }
        }
        if let path = defaults.string(forKey: "TemenAttach"), !path.isEmpty, let d = try? Data(contentsOf: URL(fileURLWithPath: path)) {
            attach(imageData: [d])
        }
        if let p = defaults.string(forKey: "TemenAutoPrompt"), !p.isEmpty { send(p) }
    }
    #endif
}
