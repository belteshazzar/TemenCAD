import Foundation
import SwiftUI
import UIKit
import TemenCAD

/// One line of the conversation as the user sees it.
struct ChatEntry: Identifiable, Codable, Equatable {
    enum Kind: String, Codable { case user, assistant, tool, image, error, status, reply, event, file }
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
    /// .file: a file the assistant exported (in Current/exports), with `text` as its description.
    var fileName: String? = nil
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
    /// The last successful build, as the script made it (render_views draws this).
    private(set) var lastResult: TemenBuildResult?
    /// The Parts list's display overrides by part name: they survive rebuilds and decide what is shown and exported.
    private var partOverrides: [String: (visible: Bool, ghost: Bool)] = [:]
    /// A printer's build plate shown under the model, with whether the visible parts fit.
    @Published private(set) var plate: Plate? { didSet { savePlate() } }
    @Published private(set) var plateFit: (fits: Bool, problems: [String]) = (true, [])
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
        if let d = UserDefaults.standard.data(forKey: "plate") { plate = try? JSONDecoder().decode(Plate.self, from: d) }
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
        if let result, result.ok {
            lastResult = result
            let names = Set(result.parts.map(\.name))
            partOverrides = partOverrides.filter { names.contains($0.key) } // stale overrides go
            applyDisplay()
        }
        return result
    }

    /// The parts as displayed: the script's flags with the Parts list's overrides.
    var displayedParts: [TemenPart] {
        (lastResult?.parts ?? []).map { p in
            guard let o = partOverrides[p.name] else { return p }
            return p.displayed(hidden: !o.visible, ghost: o.ghost)
        }
    }

    private func applyDisplay() {
        let shown = displayedParts
        preview.show(parts: shown)
        printableParts = shown.filter { !$0.ghost && !$0.hidden }
        checkPlate()
    }

    private func checkPlate() {
        guard let plate else { plateFit = (true, []); preview.showPlate(nil, fits: true); return }
        let (lo, hi) = BuildReport.bounds(printableParts.flatMap(\.positions))
        plateFit = printableParts.isEmpty ? (true, []) : (plate.problems(min: lo, max: hi).isEmpty, plate.problems(min: lo, max: hi))
        preview.showPlate(plate, fits: plateFit.fits)
    }

    private func savePlate() {
        if let plate, let d = try? JSONEncoder().encode(plate) { UserDefaults.standard.set(d, forKey: "plate") }
        else { UserDefaults.standard.removeObject(forKey: "plate") }
    }

    // MARK: - The app as tools (render_views, export_model, set_view, set_plate, set_part_display)

    /// The render sheet of the last build, shown in the chat; with `save`, a larger copy goes in the chat too.
    func renderViews(views: [String], section: (axis: String, value: Double)?, save: Bool) async throws -> Data {
        guard let r = lastResult else { throw AppError( "Nothing built yet; call run_model first") }
        let caption = views.joined(separator: ", ") + (section.map { ", cut at \($0.axis) = \(BuildReport.number($0.value))" } ?? "")
        let png = try await builder.render(parts: r.parts, views: views, width: 640, height: 480, section: section, annotations: r.annotations)
        entries.append(ChatEntry(kind: .image, text: caption, image: png))
        if save {
            let big = try await builder.render(parts: r.parts, views: views, width: 1280, height: 960, section: section, annotations: r.annotations)
            let name = "\(project.fileStem)-views.png"
            try keepExport(big, name: name)
            entries.append(ChatEntry(kind: .file, text: "\(name), the views at full size", fileName: name))
        }
        return png
    }

    /// Writes the visible, non-ghost parts (or the named ones) as STL or 3MF and puts the file in the chat
    /// with a Share button (the web app downloads it and leaves a link).
    func exportModel(format: String, parts names: [String]?, filename: String?) throws -> JSONValue {
        guard let r = lastResult, !r.parts.isEmpty else { throw AppError( "Nothing built yet; call run_model first") }
        guard format == "stl" || format == "3mf" else { throw AppError( "format must be stl or 3mf") }
        var chosen = printableParts
        if let names, !names.isEmpty {
            let all = displayedParts
            let missing = names.filter { n in !all.contains { $0.name == n } }
            if !missing.isEmpty {
                throw AppError( "no part named \(missing.map { "\"\($0)\"" }.joined(separator: ", ")); parts are \(all.map { "\"\($0.name)\"" }.joined(separator: ", "))")
            }
            chosen = names.compactMap { n in all.first { $0.name == n } }
            if chosen.contains(where: { $0.hidden || $0.ghost }) { throw AppError( "That part is hidden or a ghost; nothing to export") }
        }
        guard !chosen.isEmpty else { throw AppError( "Nothing to export: no visible, non-ghost parts") }
        let data = format == "stl" ? try TemenExport.stl(chosen) : try TemenExport.threeMF(chosen)
        let stem = (filename?.isEmpty == false ? filename! : names?.count == 1 ? names![0] : project.fileStem)
            .replacingOccurrences(of: "\\.(stl|3mf)$", with: "", options: [.regularExpression, .caseInsensitive])
            .components(separatedBy: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".-")).inverted).joined(separator: "_")
        let name = "\(stem.isEmpty ? "model" : stem).\(format)"
        try keepExport(data, name: name)
        let count = format == "stl" ? chosen.reduce(0) { $0 + $1.indices.count / 3 } : chosen.count
        let what = format == "stl" ? "\(count) triangles" : "\(count) part\(count == 1 ? "" : "s")"
        entries.append(ChatEntry(kind: .file, text: "\(name), \(what)", fileName: name))
        return ["done": true, "file": .string(name), "bytes": .number(Double(data.count)), format == "stl" ? "triangles" : "parts": .number(Double(count)),
                "in_chat": true, "note": "The file is in the chat with a Share button (AirDrop, Files, a slicer app)."]
    }

    func setView(_ view: String?, wireframe: Bool?) -> JSONValue {
        if let view { preview.frame(view: view == "reset" ? "iso" : view) }
        if let wireframe { preview.wireframe = wireframe }
        return ["view": .string(view ?? "unchanged"), "wireframe": .bool(preview.wireframe)]
    }

    func setPlate(_ id: String, size: [Double]?) throws -> JSONValue {
        guard let preset = Plate.presets.first(where: { $0.id == id }) else { throw AppError( "unknown plate \"\(id)\"") }
        if id == "none" { plate = nil }
        else if id == "custom" {
            guard let s = size, s.count == 3, s.allSatisfy({ $0.isFinite && $0 > 0 }) else { throw AppError( "plate custom needs size: [width, depth, height] in mm") }
            plate = Plate(id: id, w: s[0], d: s[1], h: s[2])
        } else if let s = preset.size { plate = Plate(id: id, w: s[0], d: s[1], h: s[2]) }
        checkPlate()
        return ["plate": plate?.json ?? .null, "fits": .bool(plateFit.fits), "problems": .array(plateFit.problems.map(JSONValue.string))]
    }

    /// The Parts list's logic (parts-panel.js apply): names (default all); visible / ghost set flags; solo shows
    /// only the named parts; reset drops every override.
    func setPartDisplay(names: [String]?, visible: Bool?, ghost: Bool?, solo: Bool, reset: Bool) throws -> JSONValue {
        let parts = lastResult?.parts ?? []
        if reset { partOverrides = [:] }
        let unknown = (names ?? []).filter { n in !parts.contains { $0.name == n } }
        if !unknown.isEmpty {
            throw AppError( "no part named \(unknown.map { "\"\($0)\"" }.joined(separator: ", ")); parts are \(parts.isEmpty ? "none" : parts.map { "\"\($0.name)\"" }.joined(separator: ", "))")
        }
        let flags = { (p: TemenPart) in self.partOverrides[p.name] ?? (visible: !p.hidden, ghost: p.ghost) }
        for p in parts {
            let picked = names == nil || names!.contains(p.name)
            if solo { var f = flags(p); f.visible = picked; partOverrides[p.name] = f }
            guard picked, visible != nil || ghost != nil else { continue }
            var f = flags(p)
            if let visible { f.visible = visible }
            if let ghost { f.ghost = ghost }
            partOverrides[p.name] = f
        }
        applyDisplay()
        var out: JSONValue = ["parts": .array(parts.map { p in let f = flags(p); return ["name": .string(p.name), "visible": .bool(f.visible), "ghost": .bool(f.ghost)] })]
        if plate != nil { out["fits_plate"] = .bool(plateFit.fits) }
        return out
    }

    static var exportsFolder: URL { ProjectStore.folder.appendingPathComponent("exports", isDirectory: true) }

    private func keepExport(_ data: Data, name: String) throws {
        try FileManager.default.createDirectory(at: Self.exportsFolder, withIntermediateDirectories: true)
        try data.write(to: Self.exportsFolder.appendingPathComponent(name), options: .atomic)
    }

    /// Opens the share sheet for a file the assistant exported.
    func shareExported(_ name: String) {
        let url = Self.exportsFolder.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: url.path) { sharing = SharedFile(url: url) }
        else { entries.append(ChatEntry(kind: .status, text: "\(name) is no longer available; ask for it again.")) }
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
        try? FileManager.default.removeItem(at: Self.exportsFolder)
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
        "rename_file": "Renaming a file", "render_views": "Rendering views", "export_model": "Exporting the model",
        "set_view": "Changing the view", "set_plate": "Setting the build plate", "set_part_display": "Changing which parts show",
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
