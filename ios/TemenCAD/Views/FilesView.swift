import SwiftUI
import UniformTypeIdentifiers

/// The project's files, as the web app's file tabs offer them: open a script to edit it, see what a font,
/// mesh or image is and how to import it, add files, start a script, rename, share and remove.
struct FilesView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var path: [String] = []
    @State private var adding = false
    @State private var naming: Naming?
    @State private var nameText = ""
    @State private var nameError: String?
    @State private var removing: String?
    @State private var replacing: (files: [(name: String, data: Data)], names: [String])?
    @State private var problem: String?
    @State private var sharing: SharedFile?

    enum Naming: Identifiable, Equatable {
        case newScript, rename(String)
        var id: String { if case .rename(let f) = self { return "rename:" + f }; return "new" }
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    ForEach(app.project.names, id: \.self) { name in
                        NavigationLink(value: name) { row(name) }
                            .swipeActions(edge: .trailing) {
                                if name != Project.entry {
                                    Button("Remove", role: .destructive) { removing = name }
                                    Button("Rename") { startRename(name) }.tint(.blue)
                                }
                            }
                            .contextMenu { menu(name) }
                    }
                } footer: {
                    Text("main.js is the entry script; other scripts are modules it imports. Fonts, meshes and images are imported from a script too: open one to see how.")
                }
            }
            .navigationTitle("Files")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { name in
                if Project.isText(name) { CodeView(file: name) } else { AssetView(file: name) }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button { nameText = app.project.uniqueName("part.js"); nameError = nil; naming = .newScript } label: { Label("New Script…", systemImage: "doc.badge.plus") }
                        Button { adding = true } label: { Label("Add Files…", systemImage: "folder.badge.plus") }
                    } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Add a file")
                }
            }
        }
        .alert(naming == .newScript ? "New script" : "Rename file", isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } }), presenting: naming) { n in
            TextField("Name", text: $nameText).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button(n == .newScript ? "Create" : "Rename") { commit(n) }
            Button("Cancel", role: .cancel) {}
        } message: { n in
            Text(nameError ?? (n == .newScript ? "Import it from main.js with import { … } from './name.js'." : "Imports that refer to the old name must be updated by hand."))
        }
        .alert("Remove \(removing ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { name in
            Button("Remove", role: .destructive) { app.removeFile(name) }
            Button("Cancel", role: .cancel) {}
        } message: { _ in Text("It is taken out of the project. Undo a reply or close without saving to get it back.") }
        .alert("Replace \(replacing?.names.joined(separator: ", ") ?? "")?", isPresented: Binding(get: { replacing != nil }, set: { if !$0 { replacing = nil } }), presenting: replacing?.names) { names in
            Button("Replace", role: .destructive) { finishAdd(replace: Set(names)) }
            Button("Keep the Project's", role: .cancel) { finishAdd(replace: []) }
        } message: { names in Text(names.count == 1 ? "A file with that name is already in the project." : "Files with those names are already in the project.") }
        .alert("Not added", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(problem ?? "") }
        .fileImporter(isPresented: $adding, allowedContentTypes: [.data], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            let files = ChatView.read(urls)
            let taken = files.compactMap { f in Project.normalizePath((f.name as NSString).lastPathComponent) }.filter { app.project.files[$0] != nil }
            if taken.isEmpty { finish(files, replace: []) } else { replacing = (files, taken) }
        }
        .sheet(item: $sharing) { f in ShareSheet(url: f.url).presentationDetents([.medium, .large]).ignoresSafeArea() }
        #if DEBUG
        .onAppear { if let f = app.debugOpenFile { path = [f] } }
        #endif
    }

    private func row(_ name: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon(name)).foregroundStyle(name == Project.entry ? Color.accentColor : .secondary).frame(width: 24)
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(.body.monospaced()).lineLimit(1)
                Text("\(name == Project.entry ? "Entry script" : Project.kind(name)) · \(ByteCountFormatter.string(fromByteCount: Int64(app.project.files[name]?.count ?? 0), countStyle: .file))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func menu(_ name: String) -> some View {
        Button { share(name) } label: { Label("Share", systemImage: "square.and.arrow.up") }
        if name != Project.entry {
            Button { startRename(name) } label: { Label("Rename…", systemImage: "pencil") }
            Button(role: .destructive) { removing = name } label: { Label("Remove", systemImage: "trash") }
        }
    }

    private func icon(_ name: String) -> String {
        switch Project.ext(name) {
        case "js", "mjs": return "curlybraces"
        case "svg": return "scribble"
        case "ttf", "otf": return "textformat"
        case "stl": return "cube"
        case "png", "jpg", "jpeg": return "photo"
        default: return "doc.text"
        }
    }

    private func startRename(_ name: String) { nameText = name; nameError = nil; naming = .rename(name) }

    private func commit(_ n: Naming) {
        do {
            switch n {
            case .newScript: try app.newScript(nameText)
            case .rename(let from): try app.renameFile(from, to: nameText)
            }
        } catch {
            // the alert closes on any button; open it again with the reason, as the web dialog keeps itself open
            nameError = "\(error)"
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { naming = n }
        }
    }

    private func finishAdd(replace: Set<String>) {
        guard let r = replacing else { return }
        replacing = nil
        finish(r.files, replace: replace)
    }

    private func finish(_ files: [(name: String, data: Data)], replace: Set<String>) {
        let r = app.addFiles(files, replace: replace)
        if !r.skipped.isEmpty {
            problem = "\(r.skipped.joined(separator: ", ")): the project takes \(Project.acceptedExtensions.map { "." + $0 }.joined(separator: ", ")) files."
        }
    }

    /// A copy in the temporary folder for the share sheet.
    private func share(_ name: String) {
        guard let data = app.project.files[name] else { return }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Share", isDirectory: true)
        try? FileManager.default.removeItem(at: folder)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent((name as NSString).lastPathComponent)
        if (try? data.write(to: url, options: .atomic)) != nil { sharing = SharedFile(url: url) }
    }
}

/// A binary file: what it is, how a script imports it, and the picture for an image (the web app's asset panel).
struct AssetView: View {
    @EnvironmentObject var app: AppModel
    let file: String
    @State private var copied = false

    var body: some View {
        List {
            Section {
                LabeledContent("Kind", value: Project.kind(file))
                LabeledContent("Size", value: ByteCountFormatter.string(fromByteCount: Int64(app.project.files[file]?.count ?? 0), countStyle: .file))
            }
            Section {
                Text(Project.usage(file)).font(.footnote.monospaced()).textSelection(.enabled)
                Button(copied ? "Copied" : "Copy") { UIPasteboard.general.string = Project.usage(file); copied = true }
            } header: { Text("Import it from a script") } footer: {
                Text("Binary files cannot be edited here; ask the assistant to use it, or paste this into a script.")
            }
            if Project.imageExtensions.contains(Project.ext(file)), let d = app.project.files[file], let img = UIImage(data: d) {
                Section("Preview") { Image(uiImage: img).resizable().scaledToFit().frame(maxHeight: 280) }
            }
        }
        .navigationTitle(file)
        .navigationBarTitleDisplayMode(.inline)
    }
}
