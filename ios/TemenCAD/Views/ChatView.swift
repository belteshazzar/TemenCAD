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
                if !e.text.isEmpty { HStack { Spacer(minLength: 40); bubble(e.text, fill: Color.accentColor.opacity(0.14)) } }
            }
        case .assistant:
            VStack(alignment: .leading, spacing: 6) {
                HStack { bubble(e.text, fill: Color(.secondarySystemBackground)); Spacer(minLength: 40) }
                if e.id == lastReplyID && !app.busy && app.canExport { exportActions }
            }
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

    /// The latest reply carries the model's files, as in the web app.
    private var lastReplyID: UUID? { app.entries.last { $0.kind == .assistant }?.id }

    private var exportActions: some View {
        HStack(spacing: 8) {
            Button { app.share(.stl) } label: { Label("STL", systemImage: "square.and.arrow.up") }
            Button { app.share(.threeMF) } label: { Label("3MF", systemImage: "square.and.arrow.up") }
        }
        .font(.caption)
        .buttonStyle(.bordered)
        .controlSize(.small)
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

    private var composer: some View {
        VStack(spacing: 0) {
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
                    .disabled((draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && app.pendingPhotos.isEmpty) || !app.hasKey)
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
