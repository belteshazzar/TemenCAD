import Foundation
import TemenCAD
import TemenEditor

/// The script editor's side of the app: completion entries from the API catalogue (the same list as the
/// web app's autocomplete), one document per file with its own undo history, and the last build's
/// errors and warnings shown in the files they point at.
enum EditorSupport {
    /// The editor configuration: the JavaScript subset with the API completions.
    static let configuration = EditorConfiguration(completions: completions)

    /// public/api-catalog.json, generated from src/api-catalog.js and copied by ios/scripts/sync-resources.sh.
    static let completions: StaticCompletions = {
        struct Entry: Decodable { let label: String; let snippet: String?; let detail: String?; let info: String?; let kind: String; let on: String? }
        struct Catalog: Decodable { let globals: [Entry]; let methods: [Entry] }
        guard let url = Bundle.main.url(forResource: "api-catalog", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let catalog = try? JSONDecoder().decode(Catalog.self, from: data) else { return StaticCompletions(globals: [], members: []) }
        func kind(_ k: String) -> Completion.Kind {
            switch k { case "function": return .function; case "method": return .method; case "constant": return .constant; default: return .text }
        }
        // as the web app ranks them: globals above the language's own words, shared shape and sketch methods first
        let globals = catalog.globals.map { Completion(label: $0.label, detail: $0.detail, info: $0.info, kind: kind($0.kind), snippet: $0.snippet, boost: 1) }
        let methods = catalog.methods.map { Completion(label: $0.label, detail: $0.detail, info: $0.info, kind: kind($0.kind), snippet: $0.snippet, boost: $0.on == "both" ? 1 : 0) }
        return StaticCompletions(globals: globals, members: methods)
    }()
}

extension AppModel {
    /// The editor document for a text file, brought up to date with the project: a change made elsewhere
    /// (the assistant, an undo in the chat) replaces the text as one undoable step, unless the editor has
    /// edits of its own not yet built.
    func editorDocument(_ file: String) -> CodeDocument {
        let current = project.text(file) ?? ""
        if let doc = editorDocuments[file] {
            if let synced = editorSynced[file], current != synced, doc.text == synced {
                doc.replaceText(current, undoable: true)
                editorSynced[file] = current
            }
            return doc
        }
        let doc = CodeDocument(text: current)
        editorDocuments[file] = doc
        editorSynced[file] = current
        doc.diagnostics = diagnostics(for: file)
        return doc
    }

    /// Whether the editor holds edits to the file that are not in the project yet.
    func editorHasEdits(_ file: String) -> Bool {
        guard let doc = editorDocuments[file] else { return false }
        return doc.text != (project.text(file) ?? "")
    }

    /// Build in the editor: its text goes into the project and the project is built.
    @discardableResult
    func buildFromEditor(_ file: String) async -> TemenBuildResult? {
        if let doc = editorDocuments[file] {
            project.files[file] = Data(doc.text.utf8)
            editorSynced[file] = doc.text
        }
        return await rebuild()
    }

    func moveEditorDocument(_ from: String, to: String?) {
        let doc = editorDocuments.removeValue(forKey: from), synced = editorSynced.removeValue(forKey: from)
        if let to, let doc { editorDocuments[to] = doc; editorSynced[to] = synced }
    }

    /// The last build's error and warnings that point at a file.
    func diagnostics(for file: String) -> [Diagnostic] {
        guard let r = console else { return [] }
        var out: [Diagnostic] = []
        if let e = r.error, let line = e.line, (e.file ?? Project.entry) == file {
            out.append(Diagnostic(line: line, severity: .error, message: e.message))
        }
        for m in r.messages where m.kind == .warning {
            if let line = m.line, (m.file ?? Project.entry) == file { out.append(Diagnostic(line: line, severity: .warning, message: m.text)) }
        }
        return out
    }

    func updateDiagnostics() {
        for (file, doc) in editorDocuments { doc.diagnostics = diagnostics(for: file) }
    }
}
