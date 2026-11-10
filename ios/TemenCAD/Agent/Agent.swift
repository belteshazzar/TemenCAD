import Foundation

/// What the agent needs from the app: the project, builds and the preview.
@MainActor
protocol AgentHost: AnyObject {
    var project: Project { get set }
    /// Build the current project, show it in the preview, and return the report the model reads.
    func buildForAgent() async -> JSONValue
    /// The preview as PNG, optionally from a preset direction; also shown in the chat.
    func screenshotForAgent(view: String?) -> Data?
    /// The last build report, for the context sent with each message.
    var lastReport: JSONValue? { get }
}

/// The modelling assistant: the same job as the web app's (src/agent.js), with the tools a phone needs.
/// A manual tool loop over the Messages API; the conversation is kept as raw JSON so it goes back unchanged.
@MainActor
final class Agent {
    static let models: [(id: String, label: String)] = [
        ("claude-opus-5-5", "Claude Opus 5.5 (default)"),
        ("claude-sonnet-5-5", "Claude Sonnet 5.5 (faster, cheaper)"),
    ]
    static let defaultModel = "claude-opus-5-5"
    static let views = ["iso", "top", "bottom", "front", "back", "left", "right"]

    weak var host: AgentHost?
    var client: AnthropicClient
    var model = Agent.defaultModel
    private(set) var messages: [JSONValue] = []

    init(client: AnthropicClient) { self.client = client }

    func reset() { messages = [] }
    func restore(_ saved: [JSONValue]) { messages = saved }

    // MARK: - Prompt

    static let system: String = {
        let resource = { (name: String) in
            (Bundle.main.url(forResource: name, withExtension: "txt")).flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        }
        let rules = resource("assistant-rules").split(separator: "\n").filter { $0.hasPrefix("- ") }.joined(separator: "\n")
        return """
        You are the modelling assistant inside TemenCAD for iPhone and iPad, where a JavaScript script describes a 3D model for 3D printing. The user types plain English in a chat beside a live 3D preview; you change the script so the model matches, then build it and check the result. The user does not see the script unless they open it, so the chat and the preview are how they follow your work.

        How to work:
        - The project's files and the last build report are included with every user message. Read them before deciding what to change. main.js is the entry script; other .js files are ES modules it imports (`import { lid } from './lid.js'`).
        - Make the smallest edit that does the job with edit_script (exact-match replacement; pass `file` for anything other than main.js). Use write_script only for new models, new files or large rewrites; remove_file deletes a script file.
        - After every change call run_model and read the report. Fix any error or warning it reports (they include line numbers) before replying. run_model also shows the result in the user's preview.
        - Use take_screenshot when the shape of the result matters and the build report can't confirm it (the first version of a new model, a visual arrangement, anything you are unsure of). It frames the model from the view you name; the user sees the picture in the chat too.
        \(rules)
        - Reply briefly in plain prose, short enough to read on a phone: what you changed and anything the user should decide. No code in the reply unless asked. Never claim a build succeeded unless run_model said so.

        The complete API reference follows. Only these functions exist; do not invent others.

        \(resource("api"))
        """
    }()

    // MARK: - Tools

    private static func tool(_ name: String, _ description: String, _ properties: [String: JSONValue], required: [String] = []) -> JSONValue {
        ["name": .string(name), "description": .string(description), "eager_input_streaming": true,
         "input_schema": ["type": "object", "properties": .object(properties), "required": .array(required.map(JSONValue.string)),
                          "additionalProperties": false]]
    }
    static let tools: [JSONValue] = [
        tool("read_script", "Read a script file (default main.js).", ["file": ["type": "string"]]),
        tool("edit_script", "Replace exactly one occurrence of old_text with new_text in a script file (default main.js). old_text must match the file exactly, including whitespace, and be unique.",
             ["old_text": ["type": "string"], "new_text": ["type": "string"], "file": ["type": "string"]], required: ["old_text", "new_text"]),
        tool("write_script", "Write a whole script file (default main.js), creating it if needed. Use for new models, new modules and large rewrites.",
             ["script": ["type": "string"], "file": ["type": "string"]], required: ["script"]),
        tool("remove_file", "Delete a script file from the project (not main.js).", ["file": ["type": "string"]], required: ["file"]),
        tool("run_model", "Build the project and return the report: parts with names, sizes, volumes and triangle counts, warnings with lines, logs, or the error with its file and line. Also shows the result in the user's preview.", [:]),
        tool("take_screenshot", "Frame the model from a view and return a picture of the preview. Y is up; +Z is the front. Build with run_model first.",
             ["view": ["type": "string", "enum": .array(views.map(JSONValue.string))]]),
    ]

    /// Context appended to every user message so the model always sees the live project.
    private func turnContext() -> String {
        guard let host else { return "" }
        let files = host.project.names.map { name in
            host.project.text(name).map { "<file name=\"\(name)\">\n\($0)\n</file>" } ?? "<file name=\"\(name)\" binary=\"true\" />"
        }.joined(separator: "\n")
        let report = host.lastReport.map { $0.text(pretty: true) } ?? "not built yet"
        return "\n\n<project>\n\(files)\n</project>\n\n<last_build>\n\(report)\n</last_build>"
    }

    private func run(_ name: String, _ input: JSONValue) async -> JSONValue {
        guard let host else { return "Error: the app is not ready." }
        let file = input["file"]?.string ?? Project.entry
        switch name {
        case "read_script":
            return host.project.text(file).map(JSONValue.string) ?? .string("Error: no script file named \(file). Files: \(host.project.names.joined(separator: ", "))")
        case "edit_script":
            guard let old = input["old_text"]?.string, let new = input["new_text"]?.string else { return "Error: old_text and new_text are required." }
            guard let src = host.project.text(file) else { return .string("Error: no script file named \(file). Files: \(host.project.names.joined(separator: ", "))") }
            let count = src.components(separatedBy: old).count - 1
            if old.isEmpty || count == 0 { return .string("Error: old_text was not found in \(file). Read the file and copy the text exactly.") }
            if count > 1 { return .string("Error: old_text occurs \(count) times in \(file); include more surrounding text so it is unique.") }
            host.project.files[file] = Data(src.replacingOccurrences(of: old, with: new).utf8)
            return .string("Edited \(file). Call run_model to build and check.")
        case "write_script":
            guard let script = input["script"]?.string else { return "Error: script is required." }
            guard Project.isText(file), !file.contains("..") else { return .string("Error: \(file) is not a script file name.") }
            host.project.files[file] = Data(script.utf8)
            return .string("Wrote \(file). Call run_model to build and check.")
        case "remove_file":
            if file == Project.entry { return "Error: main.js is the entry script and cannot be removed." }
            guard host.project.files.removeValue(forKey: file) != nil else { return .string("Error: no file named \(file).") }
            return .string("Removed \(file). Files: \(host.project.names.joined(separator: ", "))")
        case "run_model":
            return .string(await host.buildForAgent().text(pretty: true))
        case "take_screenshot":
            let view = input["view"]?.string
            guard let png = host.screenshotForAgent(view: view) else { return "Error: the preview could not be captured." }
            return [["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": .string(png.base64EncodedString())]],
                    ["type": "text", "text": .string("Screenshot from the \(view ?? "current") view. Y is up; +Z is the front.")]]
        default:
            return .string("Error: unknown tool \(name).")
        }
    }

    // MARK: - The loop

    enum Event { case text(String), tool(String), done, refusal }

    /// Send a user message (text plus optional extra content blocks) and run the tool loop until the model is done.
    /// On failure the half-finished turn is dropped, so the next message starts clean.
    func send(_ text: String, extra: [JSONValue] = [], onEvent: @escaping @MainActor (Event) -> Void) async throws {
        let before = messages
        messages.append(["role": "user", "content": .array(extra + [["type": "text", "text": .string(text + turnContext())]])])
        do {
            for _ in 0..<24 {
                let body: JSONValue = [
                    "model": .string(model),
                    "max_tokens": 64000,
                    "stream": true,
                    "system": [["type": "text", "text": .string(Self.system), "cache_control": ["type": "ephemeral"]]],
                    "thinking": ["type": "adaptive"],
                    "output_config": ["effort": "medium"],
                    "fallbacks": "default",
                    "tools": .array(Self.tools),
                    "messages": .array(messages),
                ]
                let message = try await streamWithRetry(body, onEvent: onEvent)
                var blocks = message["content"]?.array ?? []
                // keep our parse note out of what goes back to the API
                var invalid: [String: String] = [:]
                blocks = blocks.map { b in
                    var b = b
                    if let raw = b["_invalid_input"]?.string, let id = b["id"]?.string { invalid[id] = raw; b = .object((b.object ?? [:]).filter { $0.key != "_invalid_input" }) }
                    return b
                }
                messages.append(["role": "assistant", "content": .array(blocks)])
                let stop = message["stop_reason"]?.string
                if stop == "refusal" { onEvent(.refusal); return }
                let uses = blocks.filter { $0["type"]?.string == "tool_use" }
                if stop == "max_tokens" && !uses.isEmpty { throw AgentError.cutOff }
                guard stop == "tool_use", !uses.isEmpty else { onEvent(.done); return }
                var results: [JSONValue] = []
                for use in uses {
                    let id = use["id"]?.string ?? "", name = use["name"]?.string ?? ""
                    if let raw = invalid[id] {
                        results.append(["type": "tool_result", "tool_use_id": .string(id), "is_error": true,
                                        "content": .string((["INVALID_JSON": .string(raw)] as JSONValue).text())])
                        continue
                    }
                    let out = await run(name, use["input"] ?? [:])
                    let isError = out.string?.hasPrefix("Error") == true
                    results.append(["type": "tool_result", "tool_use_id": .string(id), "content": out, "is_error": .bool(isError)])
                }
                messages.append(["role": "user", "content": .array(results)])
            }
            onEvent(.done)
        } catch {
            messages = before
            throw error
        }
    }

    private func streamWithRetry(_ body: JSONValue, onEvent: @escaping @MainActor (Event) -> Void) async throws -> JSONValue {
        var attempt = 0
        while true {
            do {
                return try await client.stream(body: body) { event in
                    switch event {
                    case .text(let t): onEvent(.text(t))
                    case .toolStarted(let n): onEvent(.tool(n))
                    }
                }
            } catch let e as AnthropicClient.APIError where e.retryable && attempt < 2 {
                attempt += 1
                try await Task.sleep(nanoseconds: UInt64(attempt) * 2_000_000_000)
            }
        }
    }

    enum AgentError: LocalizedError {
        case cutOff
        var errorDescription: String? { "The reply was cut off while writing a tool call." }
    }
}
