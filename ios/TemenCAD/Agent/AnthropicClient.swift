import Foundation

/// The Messages API over HTTP with server-sent events (Swift has no official SDK).
/// One call streams one assistant message: text deltas as they come, then the complete message as JSON.
struct AnthropicClient {
    var apiKey: String
    var baseURL = URL(string: "https://api.anthropic.com")!
    static let version = "2026-10-21"
    /// Refusal fallbacks: on a safety decline the API re-runs the request on a fallback model it chooses.
    static let betas = ["server-side-fallback-2026-07-01"]

    struct APIError: LocalizedError {
        let status: Int
        let type: String
        let message: String
        var errorDescription: String? {
            switch status {
            case 401: return "The API key was rejected. Check it in Settings."
            case 403: return "This key is not allowed to use that model."
            case 429: return "Rate limited by the API. Wait a moment and try again."
            case 529: return "The API is overloaded. Try again shortly."
            default: return "API error \(status): \(message)"
            }
        }
        var retryable: Bool { status == 429 || status >= 500 }
    }

    enum Event {
        case text(String)          // a text delta in the visible reply
        case toolStarted(String)   // the model began a tool call (name)
    }

    /// Stream one message. Returns the final message JSON (role, content blocks exactly as sent, stop_reason).
    func stream(body: JSONValue, onEvent: @escaping @MainActor (Event) -> Void) async throws -> JSONValue {
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/messages"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue(Self.version, forHTTPHeaderField: "anthropic-version")
        request.setValue(Self.betas.joined(separator: ","), forHTTPHeaderField: "anthropic-beta")
        request.httpBody = body.data()
        request.timeoutInterval = 600

        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status != 200 {
            var raw = Data()
            for try await b in bytes { raw.append(b) }
            let json = try? JSONValue.parse(raw)
            throw APIError(status: status, type: json?["error"]?["type"]?.string ?? "error",
                           message: json?["error"]?["message"]?.string ?? String(decoding: raw, as: UTF8.self))
        }

        // Rebuild the message from the events. Each block starts as the API sent it and has its deltas applied,
        // so block types this app does not know (and their fields) are kept as they are.
        var message: JSONValue = ["role": "assistant", "content": []]
        var blocks: [JSONValue] = []
        var partialJSON: [Int: String] = [:]
        for try await line in bytes.lines {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard let event = try? JSONValue.parse(payload), let type = event["type"]?.string else { continue }
            switch type {
            case "message_start":
                if let m = event["message"] { message = m }
            case "content_block_start":
                guard let i = event["index"]?.number.map(Int.init), var block = event["content_block"] else { break }
                while blocks.count <= i { blocks.append(.null) }
                if block["type"]?.string == "tool_use" {
                    block["input"] = [:] as JSONValue
                    partialJSON[i] = ""
                    if let name = block["name"]?.string { await onEvent(.toolStarted(name)) }
                }
                blocks[i] = block
            case "content_block_delta":
                guard let i = event["index"]?.number.map(Int.init), i < blocks.count, let delta = event["delta"] else { break }
                switch delta["type"]?.string {
                case "text_delta":
                    let t = delta["text"]?.string ?? ""
                    blocks[i]["text"] = .string((blocks[i]["text"]?.string ?? "") + t)
                    await onEvent(.text(t))
                case "thinking_delta":
                    blocks[i]["thinking"] = .string((blocks[i]["thinking"]?.string ?? "") + (delta["thinking"]?.string ?? ""))
                case "signature_delta":
                    blocks[i]["signature"] = delta["signature"]
                case "input_json_delta":
                    partialJSON[i, default: ""] += delta["partial_json"]?.string ?? ""
                default: break
                }
            case "content_block_stop":
                guard let i = event["index"]?.number.map(Int.init), let raw = partialJSON[i] else { break }
                // eager input streaming: the API does not validate the input, so parse strictly here and
                // let the agent answer with an error result if it does not parse
                if raw.isEmpty { blocks[i]["input"] = [:] as JSONValue }
                else if let parsed = try? JSONValue.parse(raw), parsed.object != nil { blocks[i]["input"] = parsed }
                else { blocks[i]["input"] = [:] as JSONValue; blocks[i]["_invalid_input"] = .string(raw) }
                partialJSON[i] = nil
            case "message_delta":
                if let d = event["delta"]?.object { for (k, v) in d { message[k] = v } }
            case "error":
                throw APIError(status: 500, type: event["error"]?["type"]?.string ?? "error",
                               message: event["error"]?["message"]?.string ?? "stream error")
            default: break
            }
        }
        message["content"] = .array(blocks.filter { $0 != .null })
        return message
    }
}
