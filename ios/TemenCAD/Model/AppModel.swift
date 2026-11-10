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
    /// Names of the PDFs and project files attached to a user message.
    var files: [String]? = nil
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
    @Published var project: Project { didSet { ProjectStore.save(project); updateUnsaved() } }
    /// The open projects (each a workspace with its own conversation), in the order they were opened.
    @Published private(set) var workspaces: [WorkspaceInfo] = []
    /// .temen files closed recently, for Open Recent.
    @Published private(set) var recent: [RecentFile] = []
    /// The project showing has changes not yet saved to its file (or, never saved, differs from the starter).
    @Published private(set) var unsaved = false
    /// The save sheet's document: Save As, Save on a project never saved, or save_project.
    @Published var saveAsDocument: TemenDocument?
    /// The file changed elsewhere (another app or device) since it was opened: ask before replacing it.
    @Published var saveConflict = false
    /// Close → Save on a project never saved: close it once the save sheet has saved it.
    private var closeAfterSave: UUID?
    private var saveSheetToken = 0
    @Published private(set) var entries: [ChatEntry] = []
    @Published private(set) var busy = false
    @Published private(set) var buildStatus = ""
    /// The visible, non-ghost parts of the last successful build: what STL and 3MF export write.
    @Published private(set) var printableParts: [TemenPart] = []
    #if DEBUG
    /// -TemenThen changes: the reply whose Changes sheet to open.
    @Published var debugChanges: ChatEntry?
    /// -TemenThen parts / console: the sheet to open.
    @Published var debugSheet: String?
    #endif
    /// A file waiting in the share sheet.
    @Published var sharing: SharedFile?
    /// Photos waiting to go with the next message.
    @Published var pendingPhotos: [PhotoAttachment] = []
    /// Faces pointed at and measurements taken in the 3D view, waiting to go with the next message.
    @Published var pendingRefs: [ViewReference] = []
    /// PDFs and project files waiting to go with the next message.
    @Published var pendingFiles: [FileAttachment] = []
    /// add_files, open_project, save_project: the card the assistant is waiting on, with its reason.
    @Published private(set) var request: ChatRequest?
    private var requestReply: CheckedContinuation<RequestAnswer?, Never>?
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
    /// The last build's messages and error, for the console.
    @Published private(set) var console: TemenBuildResult?
    /// Bumped whenever the parts' display changes, so the Parts list redraws.
    @Published private(set) var displayGeneration = 0
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
        let index = ProjectStore.loadIndex()
        var open = index.open
        if open.isEmpty { open = [WorkspaceInfo(name: "Untitled", savedDigest: ProjectStore.digest(.starter))] }
        ProjectStore.currentID = index.current.flatMap { id in open.first { $0.id == id }?.id } ?? open[0].id
        workspaces = open
        recent = index.recent
        var loaded = ProjectStore.load()
        if let info = open.first(where: { $0.id == ProjectStore.currentID }) { loaded.name = info.name }
        project = loaded
        ProjectStore.save(loaded) // a new workspace starts with the starter on disk
        ProjectStore.saveIndex(WorkspaceIndex(open: open, current: ProjectStore.currentID, recent: index.recent))
        if let d = UserDefaults.standard.data(forKey: "plate") { plate = try? JSONDecoder().decode(Plate.self, from: d) }
        agent.host = self
        agent.model = model
        preview.onReference = { [weak self] ref in self?.pendingRefs.append(ref) }
        preview.onReferenceRemoved = { [weak self] id in self?.pendingRefs.removeAll { $0.id == id } }
        #if DEBUG
        if let k = UserDefaults.standard.string(forKey: "TemenAPIKey") { apiKey = k }
        #endif
        loadChat()
        updateUnsaved()
        Task { await rebuild() }
    }

    // MARK: - Builds

    @discardableResult
    func rebuild() async -> TemenBuildResult? {
        let result = await builder.build(project)
        lastReport = BuildReport.make(result)
        buildStatus = BuildReport.summary(result)
        console = result
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
        displayGeneration += 1
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
        let png = try await builder.render(parts: r.parts, views: views, width: 640, height: 480, labels: true, section: section, annotations: r.annotations)
        entries.append(ChatEntry(kind: .image, text: caption, image: png))
        if save {
            let big = try await builder.render(parts: r.parts, views: views, width: 1280, height: 960, labels: true, section: section, annotations: r.annotations)
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
        if view == "reset" { preview.resetView(plate: plate) } else if let view { preview.frame(view: view) }
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

    // MARK: - The Parts list and the plate menu (the user's side of the same state)

    /// Each part as displayed: visible, ghost.
    func partFlags(_ name: String) -> (visible: Bool, ghost: Bool) {
        if let o = partOverrides[name] { return o }
        let p = lastResult?.parts.first { $0.name == name }
        return (!(p?.hidden ?? false), p?.ghost ?? false)
    }

    func setPart(_ name: String, visible: Bool? = nil, ghost: Bool? = nil) {
        _ = try? setPartDisplay(names: [name], visible: visible, ghost: ghost, solo: false, reset: false)
    }

    /// Solo a part, or show every part again when it is already the only one shown (the web's double-click).
    func solo(_ name: String) {
        let parts = lastResult?.parts ?? []
        let soloed = parts.allSatisfy { ($0.name == name) == partFlags($0.name).visible }
        _ = try? setPartDisplay(names: soloed ? nil : [name], visible: soloed ? true : nil, ghost: nil, solo: !soloed, reset: false)
    }

    func showAllParts(_ visible: Bool) { _ = try? setPartDisplay(names: nil, visible: visible, ghost: nil, solo: false, reset: false) }
    func resetPartDisplay() { _ = try? setPartDisplay(names: nil, visible: nil, ghost: nil, solo: false, reset: true) }

    /// One part as STL in the share sheet (the Parts list's stl button).
    func sharePart(_ name: String) {
        guard let p = displayedParts.first(where: { $0.name == name }) else { return }
        if p.hidden || p.ghost { entries.append(ChatEntry(kind: .status, text: "\(name) is hidden or a ghost; show it to export it.")); return }
        do {
            let data = try TemenExport.stl([p])
            let safe = name.components(separatedBy: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".-")).inverted).joined(separator: "_")
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(safe.isEmpty ? "part" : safe).stl")
            try data.write(to: url, options: .atomic)
            sharing = SharedFile(url: url)
        } catch { entries.append(ChatEntry(kind: .error, text: "Could not export \(name): \(error)")) }
    }

    /// The Render views… sheet: the last build's parts as the script made them (as the web app's dialog).
    func renderSheet(views: [String], width: Int, height: Int, labels: Bool, section: (axis: String, value: Double)?) async throws -> Data {
        guard let r = lastResult else { throw AppError("Build the model first") }
        return try await builder.render(parts: r.parts, views: views, width: width, height: height, labels: labels, section: section, annotations: r.annotations)
    }

    /// The plate menu: a preset id, "custom" with a size, or "none".
    func choosePlate(_ id: String, size: [Double]? = nil) {
        do { _ = try setPlate(id, size: size) } catch { entries.append(ChatEntry(kind: .error, text: "\(error)")) }
    }

    /// What the assistant is told about the app with each message (the web app's <app> block).
    var appState: JSONValue {
        var o: JSONValue = ["project": projectInfo, "plate": plate?.json ?? .null, "wireframe": .bool(preview.wireframe),
                            "parts": .array((lastResult?.parts ?? []).map { p in let f = partFlags(p.name); return ["name": .string(p.name), "visible": .bool(f.visible), "ghost": .bool(f.ghost)] })]
        if plate != nil { o["plate_fits"] = .bool(plateFit.fits) }
        return o
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
        let photos = pendingPhotos, refs = pendingRefs, files = pendingFiles
        guard !text.isEmpty || !photos.isEmpty || !refs.isEmpty || !files.isEmpty, !busy, hasKey else { return }
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
                try photo.original.write(to: ProjectStore.attachmentURL(n, ext: "jpg"), options: .atomic)
            } catch {
                entries.append(ChatEntry(kind: .error, text: "Could not keep the photo: \(error.localizedDescription)"))
                return
            }
            blocks.append(["type": "text", "text": .string("Attachment \(n): photo (image, \(photo.sizeLabel))")])
            blocks.append(["type": "image", "source": ["type": "base64", "media_type": "image/jpeg", "data": .string(photo.shown.base64EncodedString())]])
        }
        // each PDF: kept as attachment n, shown to the model as a document block (src/chat.js words it the same)
        for pdf in files where pdf.kind == .pdf {
            let n = ProjectStore.attachmentCount() + 1
            do {
                try FileManager.default.createDirectory(at: ProjectStore.attachmentsFolder, withIntermediateDirectories: true)
                try pdf.data.write(to: ProjectStore.attachmentURL(n, ext: "pdf"), options: .atomic)
            } catch {
                entries.append(ChatEntry(kind: .error, text: "Could not keep the PDF: \(error.localizedDescription)"))
                return
            }
            blocks.append(["type": "text", "text": .string("Attachment \(n): \(pdf.name) (PDF)")])
            blocks.append(["type": "document", "title": .string(pdf.name),
                           "source": ["type": "base64", "media_type": "application/pdf", "data": .string(pdf.data.base64EncodedString())]])
        }
        pendingPhotos = []
        pendingRefs = []
        pendingFiles = []
        preview.clearPicks()
        let projectFiles = files.filter { $0.kind == .project }
        let message = !text.isEmpty ? text : refs.isEmpty || !photos.isEmpty || !files.isEmpty ? "(see the attachments)" : "(see the references)"
        var thumbs = photos.map(\.thumbnail)
        if let shot, let img = UIImage(data: shot), let small = PhotoAttachment(image: img)?.thumbnail { thumbs.insert(small, at: 0) }
        entries.append(ChatEntry(kind: .user, text: text, photos: thumbs.isEmpty ? nil : thumbs, files: files.isEmpty ? nil : files.map(\.name),
                                 references: refs.isEmpty ? nil : refs.map(\.label)))
        busy = true
        let before = project.files, turnGeneration = generation
        // project files go in inside the turn, so the reply's Undo takes them out again
        if !projectFiles.isEmpty {
            let added = addToProject(projectFiles.map { ($0.name, $0.data) })
            agent.note("The user added these files to the project with this message: \(added.joined(separator: ", ")). Import them from main.js to use them.")
        }
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

    func stop() {
        answerRequest(nil)
        task?.cancel()
    }

    func newChat() {
        stop()
        agent.reset()
        entries = []
        pendingPhotos = []
        pendingRefs = []
        pendingFiles = []
        preview.clearPicks()
        checkpoints.clear()
        try? FileManager.default.removeItem(at: Self.exportsFolder)
        try? FileManager.default.removeItem(at: ProjectStore.attachmentsFolder) // attachment numbers start again
        saveChat()
    }

    // MARK: - Photos

    func attachment(_ n: Int) -> (data: Data, pdf: Bool)? {
        guard n >= 1, let a = ProjectStore.attachment(n), let d = try? Data(contentsOf: a.url) else { return nil }
        return (d, a.ext == "pdf")
    }
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

    /// Files picked or dropped in the chat: photos to the assistant, PDFs to the assistant, the rest to the project.
    func attach(files: [(name: String, data: Data)]) {
        var problems: [String] = []
        for f in files {
            switch FileAttachment.classify(name: f.name, data: f.data) {
            case .photo:
                if pendingPhotos.count >= Self.maxPhotosPerMessage { problems.append("\(f.name): at most \(Self.maxPhotosPerMessage) photos per message."); continue }
                if let p = PhotoAttachment(imageData: f.data) { pendingPhotos.append(p) } else { problems.append("\(f.name) is not a photo the app can read.") }
            case .file(let a):
                if a.kind == .pdf {
                    let total = pendingFiles.filter { $0.kind == .pdf }.reduce(a.data.count) { $0 + $1.data.count }
                    if total > FileAttachment.maxPDFBytes { problems.append("\(a.name): the PDFs in one message must stay under 30 MB in all."); continue }
                }
                pendingFiles.removeAll { $0.kind == .project && $0.name == a.name } // the same file twice: the later one
                pendingFiles.append(a)
            case .error(let e):
                problems.append(e)
            }
        }
        if !problems.isEmpty { entries.append(ChatEntry(kind: .error, text: problems.joined(separator: "\n"))) }
    }

    /// Whether a pending project file replaces one the project already has (its chip says so).
    func replaces(_ f: FileAttachment) -> Bool {
        f.kind == .project && FileAttachment.projectName(f.name).map { project.files[$0] != nil } == true
    }

    /// Puts files in the project under their own names (replacing any of the same name); returns the names.
    @discardableResult
    private func addToProject(_ files: [(name: String, data: Data)]) -> [String] {
        var added: [String] = []
        for f in files {
            guard let name = FileAttachment.projectName(f.name) else { continue }
            project.files[name] = f.data
            added.append(name)
        }
        return added
    }

    // MARK: - Cards the assistant waits on (add_files, open_project, save_project)

    /// Shows a card in the chat and waits for the user's answer (nil: cancelled, or the turn was stopped).
    func ask(_ kind: ChatRequest.Kind, reason: String) async -> RequestAnswer? {
        answerRequest(nil) // never two at once
        request = ChatRequest(kind: kind, reason: reason)
        #if DEBUG
        debugAnswer(kind)
        #endif
        return await withCheckedContinuation { requestReply = $0 }
    }

    /// The user's answer to the card: the files or the file they picked, or nil for Cancel.
    func answerRequest(_ answer: RequestAnswer?) {
        request = nil
        let reply = requestReply
        requestReply = nil
        reply?.resume(returning: answer)
    }

    func requestFiles(reason: String) async -> JSONValue {
        guard case .files(let picked)? = await ask(.addFiles, reason: reason.isEmpty ? "Add files to the project." : reason), !picked.isEmpty else {
            return ["done": false, "reason": "cancelled or no files chosen"]
        }
        var ok: [(name: String, data: Data)] = [], skipped: [String] = []
        for f in picked {
            let ext = (f.name as NSString).pathExtension.lowercased()
            if FileAttachment.projectExtensions.contains(ext) || FileAttachment.projectImageExtensions.contains(ext) { ok.append(f) } else { skipped.append(f.name) }
        }
        let added = addToProject(ok)
        if !added.isEmpty { entries.append(ChatEntry(kind: .status, text: "Added \(added.joined(separator: ", ")) to the project.")) }
        if !skipped.isEmpty {
            entries.append(ChatEntry(kind: .error, text: "Not added (the project takes \((FileAttachment.projectExtensions + FileAttachment.projectImageExtensions).map { "." + $0 }.joined(separator: ", ")) files): \(skipped.joined(separator: ", "))"))
        }
        var r: JSONValue = ["done": .bool(!added.isEmpty), "added": .array(added.map(JSONValue.string)), "files": .array(project.names.map(JSONValue.string))]
        if !skipped.isEmpty { r["skipped"] = .array(skipped.map(JSONValue.string)); r["note"] = "Those types cannot go in the project." }
        return r
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

    // MARK: - Projects: .temen files on the device, several open at once

    private var currentIndex: Int? { workspaces.firstIndex { $0.id == ProjectStore.currentID } }
    var currentWorkspace: WorkspaceInfo? { currentIndex.map { workspaces[$0] } }
    var currentID: UUID { ProjectStore.currentID }

    /// The file the project is saved to, as "Bracket.temen"; nil for a project never saved.
    var savedFileName: String? { currentWorkspace?.bookmark == nil ? nil : project.fileName }

    func isUnsaved(_ info: WorkspaceInfo) -> Bool { info.id == ProjectStore.currentID ? unsaved : info.unsaved == true }

    private func updateUnsaved() {
        guard let i = currentIndex else { return }
        let now = ProjectStore.digest(project) != workspaces[i].savedDigest
        if now != unsaved { unsaved = now }
        if workspaces[i].unsaved != now { workspaces[i].unsaved = now; saveIndex() }
    }

    private func saveIndex() {
        ProjectStore.saveIndex(WorkspaceIndex(open: workspaces, current: ProjectStore.currentID, recent: recent))
    }

    /// What the assistant is told about the project (in <app> and from the project tools).
    var projectInfo: JSONValue {
        ["name": .string(project.name), "file": savedFileName.map(JSONValue.string) ?? .null, "unsaved": .bool(unsaved),
         "open_projects": .array(workspaces.map { .string($0.id == ProjectStore.currentID ? "\($0.name) (this one)" : $0.name) }),
         "files": .array(project.names.map(JSONValue.string))]
    }

    /// A name for a new untitled project that no open project has.
    private func untitledName() -> String {
        let names = Set(workspaces.map(\.name))
        if !names.contains("Untitled") { return "Untitled" }
        return (2...).lazy.map { "Untitled \($0)" }.first { !names.contains($0) }!
    }

    /// Shows another project. `carry`: the conversation carries on there (the assistant opened or started it)
    /// rather than switching to that project's own conversation. `build`: rebuild and frame it now.
    private func activate(_ id: UUID, project given: Project? = nil, carry: Bool = false, build: Bool = true) {
        saveChat() // the project being left keeps its conversation as it is now
        let old = ProjectStore.currentID
        if carry && old != id { ProjectStore.copyConversation(from: old, to: id) }
        pendingPhotos = []; pendingRefs = []; pendingFiles = []
        preview.clearPicks()
        ProjectStore.currentID = id
        generation += 1
        partOverrides = [:]
        lastResult = nil
        project = given ?? ProjectStore.load()
        if let i = currentIndex { project.name = workspaces[i].name }
        if carry {
            // replies from the other project cannot be undone here: their undo points are that project's files
            for i in entries.indices {
                if entries[i].reply?.changed == true { entries[i].reply = ReplyInfo(changed: false) }
                if entries[i].event != nil { entries[i].event?.used = true }
            }
            checkpoints.clear()
        } else {
            entries = []
            agent.reset()
            checkpoints.clear()
            loadChat()
        }
        updateUnsaved()
        saveIndex()
        saveChat()
        if build { Task { await rebuild(); preview.frame(view: "iso") } }
    }

    /// Adds a workspace for `project` and shows it.
    private func addWorkspace(_ project: Project, name: String, bookmark: Data? = nil, fileDate: Date? = nil, carry: Bool, build: Bool) {
        // an untouched, untitled project is replaced rather than left behind, when it has no conversation or
        // its conversation moves to the new project
        let replace = currentWorkspace.map { $0.bookmark == nil && !unsaved && (entries.isEmpty || carry) } == true ? ProjectStore.currentID : nil
        let info = WorkspaceInfo(name: name, bookmark: bookmark,
                                 savedDigest: bookmark == nil ? ProjectStore.digest(.starter) : ProjectStore.digest(project), fileDate: fileDate)
        workspaces.append(info)
        var p = project
        p.name = name
        activate(info.id, project: p, carry: carry, build: build)
        if let replace, replace != info.id { workspaces.removeAll { $0.id == replace }; ProjectStore.remove(replace); saveIndex() }
    }

    /// Switches to an open project (from the project menu).
    func switchTo(_ id: UUID) {
        guard id != ProjectStore.currentID, workspaces.contains(where: { $0.id == id }) else { return }
        guard !busy else { entries.append(ChatEntry(kind: .status, text: "Wait for the assistant to finish.")); return }
        activate(id)
    }

    /// File > New: a new untitled project beside the open ones.
    func newProject(script: String? = nil, carry: Bool = false, build: Bool = true) {
        var p = Project.starter
        if let script { p.files = [Project.entry: Data(script.utf8)] }
        addWorkspace(p, name: untitledName(), carry: carry, build: build)
    }

    static func resolve(_ bookmark: Data?) -> (url: URL, stale: Bool)? {
        guard let bookmark else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
        return (url, stale)
    }

    /// The file's modification date, read fresh (URL caches resource values, so a date read before a write
    /// would come back unchanged after it).
    private static func modified(_ url: URL) -> Date? {
        var fresh = url
        fresh.removeAllCachedResourceValues()
        return try? fresh.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
    }

    /// Whether the file's date moved since `known` (by more than file systems' rounding).
    private static func changed(_ url: URL, since known: Date?) -> Bool {
        guard let known, let now = modified(url) else { return false }
        return abs(now.timeIntervalSince(known)) > 0.5
    }

    /// Reads a file with a file coordinator (a provider such as iCloud Drive may need to download it first).
    private static func coordinatedRead(_ url: URL) throws -> Data {
        var error: NSError?, result: Result<Data, Error> = .failure(CocoaError(.fileReadUnknown))
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &error) { u in result = Result { try Data(contentsOf: u) } }
        if let error { throw error }
        return try result.get()
    }

    /// Opens a .temen (from Open…, Open Recent, Files, AirDrop or another app) as a project beside the open
    /// ones, or shows it if it is open already. A conversation the web app kept in the file is not shown here
    /// (the two apps keep conversations differently) but is kept and written back when the project is saved.
    /// Returns whether it opened.
    @discardableResult
    func open(url: URL, carry: Bool = false, build: Bool = true) -> Bool {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let path = url.standardizedFileURL.path
        if let existing = workspaces.first(where: { Self.resolve($0.bookmark)?.url.standardizedFileURL.path == path }) {
            if existing.id != ProjectStore.currentID { activate(existing.id, carry: carry, build: build) }
            // unchanged here but changed in the file (another device): take the file's version
            if !unsaved, let i = currentIndex, Self.changed(url, since: workspaces[i].fileDate), let date = Self.modified(url),
               let data = try? Self.coordinatedRead(url), let fresh = try? Project(temen: data, name: workspaces[i].name) {
                workspaces[i].savedDigest = ProjectStore.digest(fresh)
                workspaces[i].fileDate = date
                project = fresh
                entries.append(ChatEntry(kind: .status, text: "Reloaded \(url.lastPathComponent): it changed since it was opened."))
                saveIndex()
                if build { Task { await rebuild() } }
            } else {
                entries.append(ChatEntry(kind: .status, text: "\(url.lastPathComponent) is already open."))
            }
            return true
        }
        do {
            let name = url.deletingPathExtension().lastPathComponent
            let opened = try Project(temen: try Self.coordinatedRead(url), name: name)
            let bookmark = try? url.bookmarkData()
            addWorkspace(opened, name: name, bookmark: bookmark, fileDate: Self.modified(url), carry: carry, build: build)
            if bookmark == nil { entries.append(ChatEntry(kind: .status, text: "\(url.lastPathComponent) can't be saved in place; Save will ask where to save it.")) }
            let kept = opened.extras.isEmpty ? "" : " The conversation saved with it in the web app is kept in the file but not shown here."
            entries.append(ChatEntry(kind: .status, text: "Opened \(url.lastPathComponent).\(kept)"))
            recent.removeAll { $0.name == name && Self.resolve($0.bookmark)?.url.standardizedFileURL.path == path }
            saveIndex()
            saveChat()
            return true
        } catch {
            entries.append(ChatEntry(kind: .error, text: "Could not open \(url.lastPathComponent): \(error.localizedDescription)"))
            return false
        }
    }

    /// Open Recent.
    func openRecent(_ r: RecentFile) {
        guard let (url, _) = Self.resolve(r.bookmark) else {
            recent.removeAll { $0 == r }; saveIndex()
            entries.append(ChatEntry(kind: .error, text: "\(r.name).temen can no longer be found."))
            return
        }
        open(url: url)
    }

    enum SaveOutcome { case saved, needsSaveAs, conflict, failed }

    /// File > Save: writes the project to its file in place; a project never saved (or whose file is gone)
    /// opens the save sheet. `force` replaces a file that changed elsewhere since it was opened.
    @discardableResult
    func save(force: Bool = false) -> SaveOutcome {
        guard let i = currentIndex, let (url, stale) = Self.resolve(workspaces[i].bookmark) else { saveAs(); return .needsSaveAs }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        if !force, Self.changed(url, since: workspaces[i].fileDate) {
            saveConflict = true
            return .conflict
        }
        do {
            let data = try project.temen()
            var error: NSError?, writeError: Error?
            // not atomic: an atomic write puts a temporary file beside it, in a folder the app may not have access to
            NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &error) { u in
                do { try data.write(to: u) } catch { writeError = error }
            }
            if let e = error ?? writeError { throw e }
            workspaces[i].savedDigest = ProjectStore.digest(project)
            workspaces[i].fileDate = Self.modified(url)
            if stale, let fresh = try? url.bookmarkData() { workspaces[i].bookmark = fresh }
            updateUnsaved()
            saveIndex()
            entries.append(ChatEntry(kind: .status, text: "Saved \(url.lastPathComponent)."))
            saveChat()
            if closeAfterSave == workspaces[i].id { closeAfterSave = nil; close(workspaces[i].id, discard: true) }
            return .saved
        } catch {
            entries.append(ChatEntry(kind: .error, text: "Could not save \(url.lastPathComponent): \(error.localizedDescription)"))
            return .failed
        }
    }

    /// File > Save As…: the save sheet, to pick a name and a place.
    func saveAs() {
        saveAsDocument = temenDocument()
    }

    /// The project as a .temen document for the save sheet, or nil (with the reason in the chat).
    func temenDocument() -> TemenDocument? {
        do { return TemenDocument(data: try project.temen()) }
        catch { entries.append(ChatEntry(kind: .error, text: "Could not save the project: \(error)")); return nil }
    }

    /// After the save sheet saved the project: it is now that file (its name, saved in place from now on).
    func saved(to url: URL) {
        saveSheetToken += 1
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let i = currentIndex else { return }
        // another open project saved to the same file is no longer linked to it (this one replaced it)
        let path = url.standardizedFileURL.path
        for j in workspaces.indices where j != i && Self.resolve(workspaces[j].bookmark)?.url.standardizedFileURL.path == path {
            workspaces[j].bookmark = nil
            workspaces[j].unsaved = true
        }
        let name = url.deletingPathExtension().lastPathComponent
        workspaces[i].name = name
        workspaces[i].bookmark = try? url.bookmarkData()
        workspaces[i].fileDate = Self.modified(url)
        project.name = name
        workspaces[i].savedDigest = ProjectStore.digest(project)
        updateUnsaved()
        saveIndex()
        entries.append(ChatEntry(kind: .status, text: "Saved \(url.lastPathComponent)."))
        saveChat()
        if request?.kind == .saveAs { answerRequest(.url(url)) }
        if closeAfterSave == workspaces[i].id { closeAfterSave = nil; close(workspaces[i].id, discard: true) }
    }

    func report(_ error: Error) { entries.append(ChatEntry(kind: .error, text: error.localizedDescription)) }

    /// The save sheet went away: a cancel unless saved(to:) follows (the sheet has no cancel callback for documents).
    func saveSheetDismissed() {
        let token = saveSheetToken
        Task {
            try? await Task.sleep(nanoseconds: 600_000_000)
            if saveSheetToken == token { saveAsCancelled() }
        }
    }

    /// The save sheet was cancelled.
    func saveAsCancelled() {
        closeAfterSave = nil
        if request?.kind == .saveAs { answerRequest(nil) }
    }

    /// Close → Save: saves (in place, or through the save sheet) and closes once it has.
    func saveAndClose(_ id: UUID) {
        if id != ProjectStore.currentID { switchTo(id) }
        closeAfterSave = id
        if save() == .failed { closeAfterSave = nil } // .saved has closed it; a conflict waits for the user's answer
    }

    /// The user kept the file that changed elsewhere (neither replaced it nor saved a copy).
    func conflictCancelled() { closeAfterSave = nil }

    /// Closes a project (the menu asks first when it has unsaved changes); its workspace is deleted. The last
    /// one closed leaves a new untitled project. A saved file goes on Open Recent.
    func close(_ id: UUID, discard: Bool = false) {
        guard let info = workspaces.first(where: { $0.id == id }) else { return }
        guard !busy else { entries.append(ChatEntry(kind: .status, text: "Wait for the assistant to finish.")); return }
        if let bookmark = info.bookmark {
            let path = Self.resolve(bookmark)?.url.standardizedFileURL.path
            recent.removeAll { $0.name == info.name || (path != nil && Self.resolve($0.bookmark)?.url.standardizedFileURL.path == path) }
            recent.insert(RecentFile(name: info.name, bookmark: bookmark), at: 0)
            if recent.count > 10 { recent.removeLast(recent.count - 10) }
        }
        if id == ProjectStore.currentID {
            if let next = workspaces.last(where: { $0.id != id }) {
                activate(next.id)
            } else {
                let fresh = WorkspaceInfo(name: "Untitled", savedDigest: ProjectStore.digest(.starter))
                workspaces.append(fresh)
                activate(fresh.id, project: .starter)
            }
        }
        workspaces.removeAll { $0.id == id }
        ProjectStore.remove(id)
        saveIndex()
    }

    // MARK: - Project tools

    func newProjectForAgent(script: String?) async -> JSONValue {
        newProject(script: script, carry: true, build: false)
        entries.append(ChatEntry(kind: .status, text: "Started \(project.name); the other projects are still open."))
        var r = projectInfo
        r["done"] = true
        r["build"] = await buildForAgent()
        return r
    }

    func openProjectForAgent() async -> JSONValue {
        guard case .url(let url)? = await ask(.open, reason: "Choose a TemenCAD project (.temen) to open.") else { return ["done": false, "reason": "cancelled"] }
        guard open(url: url, carry: true, build: false) else { return ["done": false, "error": .string("could not open \(url.lastPathComponent)")] }
        var r = projectInfo
        r["done"] = true
        r["build"] = await buildForAgent()
        return r
    }

    func saveProjectForAgent(asNew: Bool) async -> JSONValue {
        if !asNew, currentWorkspace?.bookmark != nil {
            switch save() {
            case .saved: var r = projectInfo; r["done"] = true; r["saved_in_place"] = true; return r
            case .conflict: return ["done": false, "reason": "the file changed on the device since it was opened (another app or device); the user is being asked whether to replace it or save a copy"]
            case .failed: return ["done": false, "error": "the file could not be written; the reason is in the chat"]
            case .needsSaveAs: break
            }
        }
        guard case .url? = await ask(.saveAs, reason: savedFileName == nil || asNew ? "Choose where to save the project." : "Save \(project.fileName): choose where to save it.") else {
            return ["done": false, "reason": "cancelled"]
        }
        var r = projectInfo
        r["done"] = true
        return r
    }

    static let toolLabels = [
        "read_script": "Reading the script", "edit_script": "Editing the script", "write_script": "Writing the script",
        "remove_file": "Removing a file", "run_model": "Building the model", "take_screenshot": "Taking a screenshot",
        "save_attachment": "Adding the photo to the project",
        "add_files": "Asking for files",
        "new_project": "Starting a new project", "open_project": "Opening a project", "save_project": "Saving the project",
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
    /// -TemenAddFiles "/a/bolt.stl|/b/logo.svg" answers add_files; -TemenRequestURL /path answers open_project
    /// (opens that file) or save_project's Save as (writes there); "none" cancels either.
    private func debugAnswer(_ kind: ChatRequest.Kind) {
        let d = UserDefaults.standard
        guard let value = d.string(forKey: kind == .addFiles ? "TemenAddFiles" : "TemenRequestURL"), !value.isEmpty else { return }
        Task {
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            if value == "none" { answerRequest(nil); return }
            switch kind {
            case .addFiles:
                answerRequest(.files(value.split(separator: "|").compactMap { p in
                    let url = URL(fileURLWithPath: String(p))
                    return (try? Data(contentsOf: url)).map { (url.lastPathComponent, $0) }
                }))
            case .open: answerRequest(.url(URL(fileURLWithPath: value)))
            case .saveAs:
                let url = URL(fileURLWithPath: value)
                if let doc = temenDocument(), (try? doc.data.write(to: url)) != nil { saved(to: url) }
            }
        }
    }

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
        // -TemenAttach "/a/photo.jpg|/b/drawing.pdf|/c/bolt.stl": attached as if picked in the chat
        if let paths = defaults.string(forKey: "TemenAttach"), !paths.isEmpty {
            attach(files: paths.split(separator: "|").compactMap { p in
                let url = URL(fileURLWithPath: String(p))
                return (try? Data(contentsOf: url)).map { (url.lastPathComponent, $0) }
            })
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
                    case "parts", "console", "render": debugSheet = String(step)
                    case "reset": preview.resetView(plate: plate)
                    case let s where s.hasPrefix("plate:"): choosePlate(String(s.dropFirst(6)))
                    case let s where s.hasPrefix("ghost:"): setPart(String(s.dropFirst(6)), ghost: true)
                    case let s where s.hasPrefix("hide:"): setPart(String(s.dropFirst(5)), visible: false)
                    case "point": preview.mode = .point
                    case "measure": preview.mode = .measure
                    case "addmeasure": preview.addMeasurementToMessage(); preview.clearMeasure()
                    case "send": send("make this thicker")
                    case "new": newProject()
                    case "save": save()
                    case "saveforce": save(force: true)
                    case "close": close(currentID)
                    case "closediscard": close(currentID, discard: true)
                    case let s where s.hasPrefix("switch:"): if let n = Int(s.dropFirst(7)), workspaces.indices.contains(n) { switchTo(workspaces[n].id) }
                    case let s where s.hasPrefix("open:"): open(url: URL(fileURLWithPath: String(s.dropFirst(5))))
                    case let s where s.hasPrefix("edit:"): project.files[Project.entry] = Data(String(s.dropFirst(5)).utf8); await rebuild()
                    case let s where s.hasPrefix("touch:"): // another app changes the file
                        let url = URL(fileURLWithPath: String(s.dropFirst(6)))
                        try? FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(5)], ofItemAtPath: url.path)
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
