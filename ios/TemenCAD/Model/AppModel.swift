import Foundation
import SwiftUI
import TemenCAD

/// One line of the conversation as the user sees it.
struct ChatEntry: Identifiable, Codable, Equatable {
    enum Kind: String, Codable { case user, assistant, tool, image, error, status }
    var id = UUID()
    var kind: Kind
    var text: String
    var image: Data? = nil
}

/// The app: the project, its builds, the preview and the conversation. Kept on the main actor.
@MainActor
final class AppModel: ObservableObject, AgentHost {
    @Published var project: Project { didSet { ProjectStore.save(project) } }
    @Published private(set) var entries: [ChatEntry] = []
    @Published private(set) var busy = false
    @Published private(set) var buildStatus = ""
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

    func send(_ text: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !busy, hasKey else { return }
        entries.append(ChatEntry(kind: .user, text: text))
        busy = true
        task = Task {
            var replyIndex: Int?
            do {
                try await agent.send(text) { [weak self] event in
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
        saveChat()
    }

    /// Start over with the starter model (the conversation is cleared too).
    func newProject() {
        newChat()
        project = .starter
        Task { await rebuild(); preview.frame(view: "iso") }
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
    /// project there, so .temen handling can be checked without the system file sheets.
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
        if let p = defaults.string(forKey: "TemenAutoPrompt"), !p.isEmpty { send(p) }
    }
    #endif
}
