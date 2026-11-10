import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ChatView: View {
    @EnvironmentObject var app: AppModel
    var typing: FocusState<Bool>.Binding
    @Binding var showSettings: Bool
    @Binding var showCode: Bool
    @State private var draft = ""
    @State private var closing: WorkspaceInfo?
    @State private var enlarged: ChatEntry?
    @State private var opening = false
    @State private var choosingPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var takingPhoto = false
    @State private var changesFor: ChatEntry?
    /// The Files sheet: for attaching to the next message, or answering the assistant's add_files.
    @State private var importing: ImportPurpose?
    @State private var dropTargeted = false

    enum ImportPurpose { case attach, request }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        if app.entries.isEmpty {
                            Text(app.hasKey ? "Describe what you want to build or change. The assistant writes the model, builds it and checks the result."
                                            : "Add your Anthropic API key in Settings to start.")
                                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                                .frame(maxWidth: .infinity).padding(.top, 24)
                        }
                        ForEach(app.entries) { entry in row(entry).id(entry.id) }
                        if app.busy { ProgressView().padding(.leading, 4).id("busy") }
                    }
                    .padding(12)
                }
                .scrollDismissesKeyboard(.interactively)
                .onAppear { proxy.scrollTo(app.entries.last?.id, anchor: .bottom) } // a relaunch opens at the latest message
                .onChange(of: app.entries) { _, entries in
                    withAnimation { proxy.scrollTo(app.busy ? AnyHashable("busy") : AnyHashable(entries.last?.id), anchor: .bottom) }
                }
            }
            Divider()
            composer
        }
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: 12).strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 2, dash: [6]))
                    .overlay(Text("Drop photos, PDFs or project files").font(.callout).padding(8)
                        .background(.regularMaterial, in: Capsule()))
                    .padding(6).allowsHitTesting(false)
            }
        }
        .onDrop(of: [.item], isTargeted: $dropTargeted) { providers in
            guard app.hasKey else { return false }
            Task { app.attach(files: await Self.load(providers)) }
            return true
        }
        .sheet(item: $enlarged) { e in
            VStack {
                if let d = e.image, let img = UIImage(data: d) { Image(uiImage: img).resizable().scaledToFit() }
                Text(e.text).font(.caption).foregroundStyle(.secondary)
            }
            .padding()
            .presentationDetents([.large])
        }
        .photosPicker(isPresented: $choosingPhotos, selection: $photoItems,
                      maxSelectionCount: max(1, AppModel.maxPhotosPerMessage - app.pendingPhotos.count), matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task {
                var datas: [Data] = []
                for item in items { if let d = try? await item.loadTransferable(type: Data.self) { datas.append(d) } }
                app.attach(imageData: datas)
            }
        }
        #if DEBUG
        .onChange(of: app.debugChanges) { _, e in if let e { changesFor = e } }
        #endif
        .sheet(item: $changesFor) { e in
            ChangesView(title: "Changes for \(AppModel.quote(e.text))", changes: app.changes(for: e))
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { app.attach(image: $0) }.ignoresSafeArea()
        }
        .modifier(ProjectSheets(view: self))
    }

    /// The project prompts (close with unsaved changes, a file changed elsewhere) and the open and save sheets.
    fileprivate func projectSheets<V: View>(_ content: V) -> some View {
        content
        .confirmationDialog("Save the changes to \(closing?.name ?? "") before closing it?", isPresented: Binding(get: { closing != nil }, set: { if !$0 { closing = nil } }),
                            titleVisibility: .visible, presenting: closing) { w in
            Button("Save") { app.saveAndClose(w.id) }
            Button("Don't Save", role: .destructive) { app.close(w.id, discard: true) }
        } message: { _ in Text("Closing deletes the app's copy and its conversation; the .temen file stays where it is.") }
        .confirmationDialog("\(app.project.fileName) changed since it was opened, in another app or on another device.", isPresented: $app.saveConflict, titleVisibility: .visible) {
            Button("Replace It", role: .destructive) { app.save(force: true) }
            Button("Save a Copy…") { app.conflictCancelled(); app.saveAs() }
            Button("Cancel", role: .cancel) { app.conflictCancelled() }
        }
        .fileImporter(isPresented: $opening, allowedContentTypes: [.temenProject, .zip]) { result in
            guard case .success(let url) = result else { return }
            if app.request?.kind == .open { app.answerRequest(.url(url)) } else { app.open(url: url) }
        }
        .fileExporter(isPresented: Binding(get: { app.saveAsDocument != nil }, set: { if !$0 { app.saveAsDocument = nil; app.saveSheetDismissed() } }),
                      document: app.saveAsDocument, contentType: .temenProject, defaultFilename: app.project.fileName) { result in
            switch result {
            case .success(let url): app.saved(to: url)
            case .failure(let error): app.saveAsCancelled(); app.report(error)
            }
        }
    }

    private var header: some View {
        HStack {
            projectMenu
            Spacer()
            Button { showCode = true } label: { Image(systemName: "chevron.left.forwardslash.chevron.right") }
                .accessibilityLabel("Files: the model's scripts and assets")
            Menu {
                Button("New chat") { app.newChat() }
                Divider()
                Button("Share STL…") { app.share(.stl) }.disabled(!app.canExport)
                Button("Share 3MF…") { app.share(.threeMF) }.disabled(!app.canExport)
                Divider()
                Button("Settings…") { showSettings = true }
            } label: { Image(systemName: "ellipsis.circle") }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
    }

    /// The project showing, with its unsaved marker; the menu switches projects and opens, saves and closes them.
    private var projectMenu: some View {
        Menu {
            Section("Open projects") {
                ForEach(app.workspaces) { w in
                    Button { app.switchTo(w.id) } label: {
                        let title = w.name + (app.isUnsaved(w) ? " •" : "")
                        if w.id == app.currentID { Label(title, systemImage: "checkmark") } else { Text(title) }
                    }
                }
            }
            Section {
                Button { app.newProject() } label: { Label("New Project", systemImage: "plus") }
                Button { opening = true } label: { Label("Open…", systemImage: "folder") }
                if !app.recent.isEmpty {
                    Menu {
                        ForEach(app.recent, id: \.bookmark) { r in Button(r.name) { app.openRecent(r) } }
                    } label: { Label("Open Recent", systemImage: "clock") }
                }
            }
            Section {
                Button { app.save() } label: { Label("Save", systemImage: "square.and.arrow.down") }
                    .disabled(!app.unsaved && app.savedFileName != nil)
                Button { app.saveAs() } label: { Label("Save As…", systemImage: "square.and.arrow.down.on.square") }
                Button(role: .destructive) {
                    if let w = app.currentWorkspace { if app.isUnsaved(w) { closing = w } else { app.close(w.id) } }
                } label: { Label("Close \(app.project.name)", systemImage: "xmark") }
            }
        } label: {
            HStack(spacing: 4) {
                Text(app.project.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                if app.unsaved { Circle().fill(.secondary).frame(width: 6, height: 6).accessibilityLabel("unsaved changes") }
                if app.workspaces.count > 1 { Text("\(app.workspaces.count)").font(.caption2.bold()).padding(.horizontal, 5).padding(.vertical, 1).background(Color(.tertiarySystemFill), in: Capsule()) }
                Image(systemName: "chevron.down").font(.caption2.bold())
            }
            .foregroundStyle(.primary)
        }
        .disabled(app.busy)
        .accessibilityLabel("Project \(app.project.name)\(app.unsaved ? ", unsaved changes" : "")")
    }

    @ViewBuilder
    private func row(_ e: ChatEntry) -> some View {
        switch e.kind {
        case .user:
            VStack(alignment: .trailing, spacing: 6) {
                if let photos = e.photos, !photos.isEmpty {
                    HStack(spacing: 6) {
                        Spacer(minLength: 40)
                        ForEach(Array(photos.enumerated()), id: \.offset) { _, d in
                            if let img = UIImage(data: d) {
                                Image(uiImage: img).resizable().scaledToFill().frame(width: 72, height: 72)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                                    .onTapGesture { enlarged = ChatEntry(kind: .image, text: "Attached photo", image: d) }
                            }
                        }
                    }
                }
                if let files = e.files, !files.isEmpty {
                    VStack(alignment: .trailing, spacing: 4) {
                        ForEach(Array(files.enumerated()), id: \.offset) { _, name in
                            let pdf = (name as NSString).pathExtension.lowercased() == "pdf"
                            Label(pdf ? name : "\(name), added to the project", systemImage: pdf ? "doc.richtext" : "doc.badge.plus")
                                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }
                if let refs = e.references, !refs.isEmpty {
                    VStack(alignment: .trailing, spacing: 4) {
                        ForEach(Array(refs.enumerated()), id: \.offset) { _, label in
                            Label(label, systemImage: label.hasPrefix("Measured") ? "ruler" : "hand.point.up.left")
                                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }
                if !e.text.isEmpty { HStack { Spacer(minLength: 40); bubble(e.text, fill: Color.accentColor.opacity(0.14)) } }
            }
        case .assistant:
            HStack { bubble(e.text, fill: Color(.secondarySystemBackground)); Spacer(minLength: 40) }
        case .reply:
            replyActions(e)
        case .event:
            eventLine(e)
        case .file:
            HStack(spacing: 8) {
                Image(systemName: "doc").foregroundStyle(.secondary)
                Text(e.text).font(.caption).lineLimit(2)
                Spacer(minLength: 4)
                Button { app.shareExported(e.fileName ?? "") } label: { Label("Share", systemImage: "square.and.arrow.up") }
                    .font(.caption).buttonStyle(.bordered).controlSize(.small)
            }
            .padding(8)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
        case .tool:
            Text("\(e.text)…").font(.caption).foregroundStyle(.secondary).padding(.leading, 4)
        case .status:
            Text(e.text).font(.caption).foregroundStyle(.secondary).padding(.leading, 4)
        case .error:
            bubble(e.text, fill: Color.red.opacity(0.12)).foregroundStyle(.red)
        case .image:
            if let d = e.image, let img = UIImage(data: d) {
                VStack(alignment: .leading, spacing: 4) {
                    Image(uiImage: img).resizable().scaledToFit().frame(maxWidth: 220)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .onTapGesture { enlarged = e }
                    Text(e.text).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }

    /// Under a turn: STL / 3MF on the latest one (the model as it is now), Undo and Changes on any that
    /// changed the project, and what it changed.
    @ViewBuilder
    private func replyActions(_ e: ChatEntry) -> some View {
        let latest = e.id == app.latestReplyID && app.canExport
        let changed = e.reply?.changed == true
        if latest || changed {
            VStack(alignment: .leading, spacing: 4) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        if latest {
                            Button { app.share(.stl) } label: { Label("STL", systemImage: "square.and.arrow.up") }
                            Button { app.share(.threeMF) } label: { Label("3MF", systemImage: "square.and.arrow.up") }
                        }
                        if changed {
                            Button { app.undo(e) } label: { Label("Undo", systemImage: "arrow.uturn.backward") }
                                .accessibilityHint("Puts the project back as it was before this reply; you can put it back afterwards")
                            Button { changesFor = e } label: { Label("Changes", systemImage: "doc.text.magnifyingglass") }
                        }
                    }
                }
                if changed, let summary = e.reply?.summary, !summary.isEmpty {
                    Text(summary).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            .font(.caption)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(app.busy)
            .padding(.leading, 4)
        }
    }

    private func eventLine(_ e: ChatEntry) -> some View {
        let undo = e.event?.undo == true
        return HStack(spacing: 8) {
            Image(systemName: undo ? "arrow.uturn.backward.circle" : "arrow.uturn.forward.circle").foregroundStyle(.secondary)
            Text("\(undo ? "Undid" : "Put back") the reply to \(AppModel.quote(e.text))")
                .font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: 4)
            Button(undo ? "Put back" : "Undo again") { app.reverse(e) }
                .font(.caption).buttonStyle(.bordered).controlSize(.small)
                .disabled(e.event?.used == true || app.busy)
        }
        .padding(.leading, 4)
    }

    private func bubble(_ text: String, fill: Color) -> some View {
        Text(LocalizedStringKey(text))
            .textSelection(.enabled)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(fill, in: RoundedRectangle(cornerRadius: 14))
    }

    private var pendingPhotos: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(app.pendingPhotos) { p in
                    if let img = UIImage(data: p.thumbnail) {
                        Image(uiImage: img).resizable().scaledToFill().frame(width: 56, height: 56)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(alignment: .topTrailing) {
                                Button { app.pendingPhotos.removeAll { $0.id == p.id } } label: {
                                    Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette)
                                        .foregroundStyle(.white, .black.opacity(0.6))
                                }
                                .accessibilityLabel("Remove this photo")
                                .offset(x: 6, y: -6)
                            }
                    }
                }
            }
            .padding(.horizontal, 12).padding(.top, 10)
        }
    }

    private var attachButton: some View {
        let photosFull = app.pendingPhotos.count >= AppModel.maxPhotosPerMessage
        return Menu {
            Button { choosingPhotos = true } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
                .disabled(photosFull)
            if CameraPicker.isAvailable {
                Button { takingPhoto = true } label: { Label("Take Photo", systemImage: "camera") }
                    .disabled(photosFull)
            }
            Button { importing = .attach } label: { Label("Choose Files…", systemImage: "folder") }
        } label: {
            Image(systemName: "paperclip").font(.title3)
        }
        .disabled(!app.hasKey)
        .accessibilityLabel("Attach photos or files")
    }

    /// PDFs (for the assistant) and project files (added with the message), each removable.
    private var pendingFiles: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(app.pendingFiles) { f in
                    HStack(spacing: 6) {
                        Text(f.extensionLabel).font(.caption2.bold().monospaced()).foregroundStyle(.white)
                            .padding(.horizontal, 4).padding(.vertical, 2)
                            .background(f.kind == .pdf ? Color.red.opacity(0.8) : Color.accentColor, in: RoundedRectangle(cornerRadius: 4))
                        VStack(alignment: .leading, spacing: 0) {
                            Text(f.name).font(.caption).lineLimit(1)
                            Text(f.kind == .pdf ? "for the assistant · \(f.sizeLabel)" : app.replaces(f) ? "replaces the project's file" : "adds to the project")
                                .font(.caption2).foregroundStyle(app.replaces(f) ? .orange : .secondary)
                        }
                        Button { app.pendingFiles.removeAll { $0.id == f.id } } label: { Image(systemName: "xmark").font(.caption2.bold()) }
                            .accessibilityLabel("Remove \(f.name)")
                    }
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                }
            }
            .padding(.horizontal, 12).padding(.top, 8)
        }
    }

    /// add_files, open_project, save_project: the assistant's reason, with the button that opens Files.
    private func requestCard(_ r: ChatRequest) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(r.reason, systemImage: r.systemImage).font(.callout)
            HStack {
                Button(r.buttonLabel) {
                    switch r.kind {
                    case .addFiles: importing = .request
                    case .open: opening = true
                    case .saveAs: app.saveAs()
                    }
                }.buttonStyle(.borderedProminent)
                Button("Cancel") { app.answerRequest(nil) }.buttonStyle(.bordered)
            }
            .controlSize(.small)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
        .padding(.horizontal, 12).padding(.top, 8)
    }

    private var pendingRefs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(app.pendingRefs) { r in
                    HStack(spacing: 4) {
                        if r.kind == .surface {
                            Circle().fill(Color(r.color ?? .systemBlue)).frame(width: 10, height: 10)
                        } else {
                            Image(systemName: "ruler").font(.caption2)
                        }
                        Text(r.label).font(.caption).lineLimit(1)
                        Button { app.removeReference(r.id) } label: { Image(systemName: "xmark").font(.caption2.bold()) }
                            .accessibilityLabel("Remove \(r.label)")
                    }
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background(Color(.secondarySystemBackground), in: Capsule())
                }
            }
            .padding(.horizontal, 12).padding(.top, 8)
        }
    }

    private var composer: some View {
        VStack(spacing: 0) {
            if !app.pendingRefs.isEmpty { pendingRefs }
            if !app.pendingPhotos.isEmpty { pendingPhotos }
            if !app.pendingFiles.isEmpty { pendingFiles }
            if let r = app.request { requestCard(r) }
            composerRow
        }
        .fileImporter(isPresented: Binding(get: { importing != nil }, set: { if !$0 { importing = nil } }),
                      allowedContentTypes: [.data], allowsMultipleSelection: true) { [importing] result in
            guard case .success(let urls) = result else { return }
            let files = Self.read(urls)
            if importing == .request { app.answerRequest(.files(files)) } else { app.attach(files: files) }
        }
    }

    /// Files picked in the Files sheet (outside the sandbox, so each is opened with its security scope).
    static func read(_ urls: [URL]) -> [(name: String, data: Data)] {
        urls.compactMap { url in
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            return (try? Data(contentsOf: url)).map { (url.lastPathComponent, $0) }
        }
    }

    /// Files dropped on the chat (iPad: from Files or another app), with their names where the source gives one.
    static func load(_ providers: [NSItemProvider]) async -> [(name: String, data: Data)] {
        var out: [(name: String, data: Data)] = []
        for p in providers {
            guard let type = p.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .data) == true }) ?? p.registeredTypeIdentifiers.first else { continue }
            let data: Data? = await withCheckedContinuation { c in _ = p.loadDataRepresentation(forTypeIdentifier: type) { d, _ in c.resume(returning: d) } }
            guard let data else { continue }
            let ext = UTType(type)?.preferredFilenameExtension
            var name = p.suggestedName ?? "dropped"
            if let ext, (name as NSString).pathExtension.isEmpty { name += "." + ext }
            out.append((name, data))
        }
        return out
    }

    private var composerRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            attachButton.padding(.bottom, 4)
            TextField(app.hasKey ? "Describe a change" : "Add your API key in Settings", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.roundedBorder)
                .focused(typing)
                .disabled(!app.hasKey)
                .onSubmit(sendDraft)
            if app.busy {
                Button("Stop") { app.stop() }.buttonStyle(.bordered)
            } else {
                Button(action: sendDraft) { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                    .disabled((draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && app.pendingPhotos.isEmpty && app.pendingRefs.isEmpty && app.pendingFiles.isEmpty) || !app.hasKey)
                    .accessibilityLabel("Send")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private func sendDraft() {
        let t = draft
        draft = ""
        typing.wrappedValue = false // drop the keyboard so the result shows in the preview
        app.send(t)
    }
}

/// ChatView's project prompts and sheets, split out of its body so the compiler can check it.
private struct ProjectSheets: ViewModifier {
    let view: ChatView
    func body(content: Content) -> some View { view.projectSheets(content) }
}
