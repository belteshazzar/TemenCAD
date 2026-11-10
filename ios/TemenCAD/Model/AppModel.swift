import Foundation
import SwiftUI
import UIKit
import TemenCAD

/// One line of the conversation as the user sees it.
struct ChatEntry: Identifiable, Codable, Equatable {
    enum Kind: String, Codable { case user, assistant, tool, image, error, status, reply, event }
    var id = UUID()
    var kind: Kind
    var text: String
    var image: Data? = nil
    /// Thumbnails of the photos attached to a user message.
    var photos: [Data]? = nil
    /// Labels of the faces pointed at and the measurements sent with a user message.
    var references: [String]? = nil
    /// .reply: the actions under a turn. `text` is the user's message it answered.
    var reply: ReplyInfo? = nil
    /// .event: an undo or a put back. `text` is the message of the reply it was about.
    var event: EventInfo? = nil
}

/// A turn's result: whether it changed the project, and the checkpoints either side when it did.
struct ReplyInfo: Codable, Equatable {
    var changed: Bool
    var before: Int?
    var after: Int?
    var summary: String?
}

/// An undo of a reply, or putting one back; `putBack` is the checkpoint that reverses it.
struct EventInfo: Codable, Equatable {
    var undo: Bool
    var putBack: Int
    var used = false
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
    #if DEBUG
    /// -TemenThen changes: the reply whose Changes sheet to open.
    @Published var debugChanges: ChatEntry?
    #endif
    /// A file waiting in the share sheet.
    @Published var sharing: SharedFile?
    /// Photos waiting to go with the next message.
    @Published var pendingPhotos: [PhotoAttachment] = []
    /// Faces pointed at and measurements taken in the 3D view, waiting to go with the next message.
    @Published var pendingRefs: [ViewReference] = []
    static let maxPhotosPerMessage = 5
    @Published var apiKey: String { didSet { Keychain.write(apiKey); agent.client.apiKey = apiKey } }
    @Published var model: String { didSet { UserDefaults.standard.set(model, forKey: "model"); agent.model = model } }

    let preview = PreviewController()
    private let builder = ModelBuilder()
    private let agent: Agent
    private(set) var lastReport: JSONValue?
    private var task: Task<Void, Never>?
    /// The project at moments in the conversation, for undo (see Checkpoints).
    private(set) var checkpoints = Checkpoints()
    /// Bumped when the project is replaced (opened, new): a reply never undoes into another project.
    private var generation = 0

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
        preview.onReference = { [weak self] ref in self?.pendingRefs.append(ref) }
        preview.onReferenceRemoved = { [weak self] id in self?.pendingRefs.removeAll { $0.id == id } }
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
        let photos = pendingPhotos, refs = pendingRefs
        guard !text.isEmpty || !photos.isEmpty || !refs.isEmpty, !busy, hasKey else { return }
        var blocks: [JSONValue] = []
        // faces pointed at: the view as the user sees it, each highlighted in its colour, then each described
        // (worded as the web app words them, src/chat.js)
        let surfaces = refs.filter { $0.kind == .surface }
        var shot: Data?
        if !surfaces.isEmpty {
            let colors = surfaces.enumerated().map { "reference \($0.offset + 1) \($0.element.colorName ?? "")" }.joined(separator: ", ")
            if let png = preview.referenceSnapshot() {
                shot = png
                let one = surfaces.count == 1
                blocks.append(["type": "text", "text": .string("The user pointed at \(one ? "a surface" : "\(surfaces.count) surfaces") in the 3D view. This is their view, with \(one ? "it" : "each") highlighted (\(colors)); \"this\" or \"here\" in their message means \(one ? "reference 1" : "these").")])
                blocks.append(["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": .string(png.base64EncodedString())]])
            }
            for (i, r) in surfaces.enumerated() { blocks.append(["type": "text", "text": .string("Reference \(i + 1) (\(r.colorName ?? "")): \(r.text)")]) }
        }
        for m in refs where m.kind == .measurement { blocks.append(["type": "text", "text": .string("The user measured in the 3D view, \(m.text)")]) }
        // each photo: kept full size as attachment n, shown to the model downscaled with its label
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
        pendingRefs = []
        preview.clearPicks()
        let message = !text.isEmpty ? text : !photos.isEmpty ? (photos.count == 1 ? "(a photo)" : "(\(photos.count) photos)") : "(see the references)"
        var thumbs = photos.map(\.thumbnail)
        if let shot, let img = UIImage(data: shot), let small = PhotoAttachment(image: img)?.thumbnail { thumbs.insert(small, at: 0) }
        entries.append(ChatEntry(kind: .user, text: text, photos: thumbs.isEmpty ? nil : thumbs,
                                 references: refs.isEmpty ? nil : refs.map(\.label)))
        busy = true
        let before = project.files, turnGeneration = generation
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
            endTurn(message: message, before: before, generation: turnGeneration)
            saveChat()
        }
    }

    /// After a turn: checkpoint what it changed and put the actions (Undo, Changes, STL / 3MF) under it.
    private func endTurn(message: String, before: [String: Data], generation turnGeneration: Int) {
        let changed = turnGeneration == generation && before != project.files
        guard changed || canExport else { return }
        var info = ReplyInfo(changed: changed)
        if changed {
            info.before = checkpoints.add(before)
            info.after = checkpoints.add(project.files)
            info.summary = checkpoints.changes(from: info.before!, to: info.after!).map(\.summary).joined(separator: ", ")
        }
        entries.append(ChatEntry(kind: .reply, text: message, reply: info))
    }

    // MARK: - Undo

    /// Puts the project back as it was before the reply in `entry`.
    func undo(_ entry: ChatEntry) {
        guard let before = entry.reply?.before else { return }
        let later = !(entry.reply?.after.map { checkpoints.matches($0, project.files) } ?? true)
        restore(to: before, about: entry.text, undo: true) {
            "The user pressed Undo on your reply to \(Self.quote(entry.text)): the project is now exactly as it was before that reply\(later ? " (this also took out every change made since)" : "")."
        }
    }

    /// Reverses an undo (Put back) or an earlier put back (Undo again).
    func reverse(_ entry: ChatEntry) {
        guard let event = entry.event, !event.used, let i = entries.firstIndex(where: { $0.id == entry.id }) else { return }
        let done = restore(to: event.putBack, about: entry.text, undo: !event.undo) {
            event.undo ? "The user put back your reply to \(Self.quote(entry.text)) after undoing it: the project is as it was just before the undo."
                       : "The user undid your reply to \(Self.quote(entry.text)) again."
        }
        if done { entries[i].event?.used = true; saveChat() }
    }

    /// Restores checkpoint `index`, first keeping the current project as a checkpoint so the restore can
    /// be put back. Adds an event line and tells the model with the next message.
    @discardableResult
    private func restore(to index: Int, about message: String, undo: Bool, note: () -> String) -> Bool {
        guard !busy else { entries.append(ChatEntry(kind: .status, text: "Wait for the assistant to finish.")); return false }
        guard let files = checkpoints.files(index) else {
            entries.append(ChatEntry(kind: .error, text: "That undo point is no longer available.")); return false
        }
        if files == project.files { entries.append(ChatEntry(kind: .status, text: "The project is already like that.")); return false }
        let putBack = checkpoints.add(project.files)
        project.files = files
        entries.append(ChatEntry(kind: .event, text: message, event: EventInfo(undo: undo, putBack: putBack)))
        agent.note(note())
        saveChat()
        Task { await rebuild() }
        return true
    }

    /// The user's message, short, in quotes, for the event lines and the notes to the model.
    static func quote(_ s: String) -> String {
        let one = s.split(whereSeparator: \.isNewline).joined(separator: " ")
        return "\u{201C}" + (one.count > 60 ? one.prefix(57) + "…" : one) + "\u{201D}"
    }

    func changes(for entry: ChatEntry) -> [FileChange] {
        guard let a = entry.reply?.before, let b = entry.reply?.after else { return [] }
        return checkpoints.changes(from: a, to: b)
    }

    /// The latest reply row: the one that carries the STL / 3MF buttons.
    var latestReplyID: UUID? { entries.last { $0.kind == .reply }?.id }

    func stop() { task?.cancel() }

    func newChat() {
        stop()
        agent.reset()
        entries = []
        pendingPhotos = []
        pendingRefs = []
        preview.clearPicks()
        checkpoints.clear()
        try? FileManager.default.removeItem(at: ProjectStore.attachmentsFolder) // attachment numbers start again
        saveChat()
    }

    /// Start over with the starter model (the conversation is cleared too).
    func newProject() {
        newChat()
        generation += 1
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

    /// A reference chip was removed from the composer: drop its highlight too.
    func removeReference(_ id: Int) {
        pendingRefs.removeAll { $0.id == id }
        preview.removePick(id)
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
            generation += 1
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

    private struct SavedChat: Codable {
        var entries: [ChatEntry]
        var messages: [JSONValue]
        var checkpoints: [[String: String]]? = nil
        var notes: [String]? = nil
    }

    private func saveChat() {
        let saved = SavedChat(entries: entries, messages: agent.messages, checkpoints: checkpoints.list, notes: agent.notes)
        try? FileManager.default.createDirectory(at: ProjectStore.folder, withIntermediateDirectories: true)
        try? JSONEncoder().encode(saved).write(to: ProjectStore.chatFile, options: .atomic)
    }

    private func loadChat() {
        guard let d = try? Data(contentsOf: ProjectStore.chatFile), let saved = try? JSONDecoder().decode(SavedChat.self, from: d) else { return }
        entries = saved.entries
        agent.restore(saved.messages, notes: saved.notes ?? [])
        checkpoints.restore(saved.checkpoints ?? [])
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
        // -TemenThen "undo,putback,undoagain,changes" (undo), "point,tap:0.5:0.5,measure,tap:..,tap:..,addmeasure,send"
        // (pointing and measuring): steps once the turn is over
        if let steps = defaults.string(forKey: "TemenThen"), !steps.isEmpty {
            Task {
                while busy { try? await Task.sleep(nanoseconds: 200_000_000) }
                for step in steps.split(separator: ",") {
                    try? await Task.sleep(nanoseconds: 800_000_000)
                    switch step {
                    case "undo": if let e = entries.last(where: { $0.reply?.changed == true }) { undo(e) }
                    case "putback", "undoagain": if let e = entries.last(where: { $0.kind == .event }) { reverse(e) }
                    case "changes": if let e = entries.last(where: { $0.reply?.changed == true }) { debugChanges = e }
                    case "point": preview.mode = .point
                    case "measure": preview.mode = .measure
                    case "addmeasure": preview.addMeasurementToMessage(); preview.clearMeasure()
                    case "send": send("make this thicker")
                    case let s where s.hasPrefix("tap:"): // tap:0.5:0.6 taps at those fractions of the view
                        let f = s.dropFirst(4).split(separator: ":").compactMap { Double($0) }
                        if f.count == 2 { let b = preview.view.bounds; preview.tap(at: CGPoint(x: b.width * f[0], y: b.height * f[1])) }
                    default: break
                    }
                }
            }
        }
    }
    #endif
}
