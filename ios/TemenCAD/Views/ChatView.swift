import PhotosUI
import SwiftUI

struct ChatView: View {
    @EnvironmentObject var app: AppModel
    var typing: FocusState<Bool>.Binding
    @Binding var showSettings: Bool
    @Binding var showCode: Bool
    @State private var draft = ""
    @State private var confirmNew = false
    @State private var enlarged: ChatEntry?
    @State private var opening = false
    @State private var saving: TemenDocument?
    @State private var choosingPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var takingPhoto = false
    @State private var changesFor: ChatEntry?

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
        .sheet(item: $enlarged) { e in
            VStack {
                if let d = e.image, let img = UIImage(data: d) { Image(uiImage: img).resizable().scaledToFit() }
                Text(e.text).font(.caption).foregroundStyle(.secondary)
            }
            .padding()
            .presentationDetents([.large])
        }
        .confirmationDialog("Start a new model? The current model and this conversation are replaced.", isPresented: $confirmNew, titleVisibility: .visible) {
            Button("New model", role: .destructive) { app.newProject() }
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
        .fileImporter(isPresented: $opening, allowedContentTypes: [.temenProject, .zip]) { result in
            if case .success(let url) = result { app.open(url: url) }
        }
        .fileExporter(isPresented: Binding(get: { saving != nil }, set: { if !$0 { saving = nil } }),
                      document: saving, contentType: .temenProject, defaultFilename: app.project.fileName) { result in
            if case .success(let url) = result { app.saved(to: url) }
        }
    }

    private var header: some View {
        HStack {
            Text(Agent.models.first { $0.id == app.model }?.label ?? app.model)
                .font(.caption).foregroundStyle(.secondary)
            Spacer()
            Button { showCode = true } label: { Image(systemName: "chevron.left.forwardslash.chevron.right") }
                .accessibilityLabel("Show the model's script")
            Menu {
                Button("New chat") { app.newChat() }
                Button("New model…") { confirmNew = true }
                Divider()
                Button("Open…") { opening = true }
                Button("Save as .temen…") { saving = app.temenDocument() }
                Button("Share STL…") { app.share(.stl) }.disabled(!app.canExport)
                Button("Share 3MF…") { app.share(.threeMF) }.disabled(!app.canExport)
                Divider()
                Button("Settings…") { showSettings = true }
            } label: { Image(systemName: "ellipsis.circle") }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
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

    private var photoButton: some View {
        Menu {
            Button { choosingPhotos = true } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
            if CameraPicker.isAvailable {
                Button { takingPhoto = true } label: { Label("Take Photo", systemImage: "camera") }
            }
        } label: {
            Image(systemName: "photo.badge.plus").font(.title3)
        }
        .disabled(!app.hasKey || app.pendingPhotos.count >= AppModel.maxPhotosPerMessage)
        .accessibilityLabel("Attach a photo")
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
            composerRow
        }
    }

    private var composerRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            photoButton.padding(.bottom, 4)
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
                    .disabled((draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && app.pendingPhotos.isEmpty && app.pendingRefs.isEmpty) || !app.hasKey)
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
