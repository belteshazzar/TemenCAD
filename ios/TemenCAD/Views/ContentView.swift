import SwiftUI

/// Chat with the 3D preview: on a phone in portrait the preview sits on top; on a phone in landscape and on
/// iPad it sits beside the chat. The preview can be expanded to the whole screen.
struct ContentView: View {
    @EnvironmentObject var app: AppModel
    @State private var expanded = false
    @State private var showSettings = false
    @State private var showCode = false
    @State private var showParts = false
    @State private var showConsole = false
    @State private var customPlate = false
    @State private var renderViews = false
    @FocusState private var typing: Bool

    var body: some View {
        GeometryReader { geo in
            let wide = geo.size.width > geo.size.height
            ZStack {
                if expanded {
                    preview
                } else if wide {
                    HStack(spacing: 0) {
                        preview.frame(width: geo.size.width * (geo.size.width > 900 ? 0.58 : 0.5))
                        Divider()
                        chat
                    }
                } else {
                    VStack(spacing: 0) {
                        preview.frame(height: geo.size.height * (typing ? 0.26 : 0.4))
                        Divider()
                        chat
                    }
                }
            }
            .animation(.easeInOut(duration: 0.2), value: typing)
            .animation(.easeInOut(duration: 0.2), value: expanded)
        }
        .sheet(isPresented: $showSettings) { SettingsView().environmentObject(app) }
        .sheet(isPresented: $showCode) { CodeView().environmentObject(app) }
        .sheet(isPresented: $showParts) { PartsView().environmentObject(app).presentationDetents([.medium, .large]) }
        .sheet(isPresented: $showConsole) { ConsoleView().environmentObject(app).presentationDetents([.medium, .large]) }
        .sheet(isPresented: $customPlate) { CustomPlateView().environmentObject(app).presentationDetents([.medium]) }
        .sheet(isPresented: $renderViews) { RenderViewsView().environmentObject(app) }
        .sheet(item: $app.sharing) { file in
            ShareSheet(url: file.url).presentationDetents([.medium, .large]).ignoresSafeArea()
        }
        #if DEBUG
        .onChange(of: app.debugSheet) { _, s in showParts = s == "parts"; showConsole = s == "console"; renderViews = s == "render" }
        #endif
        .onAppear {
            if !app.hasKey { showSettings = true }
            #if DEBUG
            app.runAutoPrompt()
            #endif
        }
    }

    private var preview: some View {
        ModelPreview(controller: app.preview)
            .ignoresSafeArea(edges: expanded ? .all : [.top, .horizontal])
            .overlay(alignment: .topTrailing) {
                HStack(spacing: 8) {
                    Menu {
                        Button { app.share(.stl) } label: { Label("Share STL", systemImage: "cube") }
                        Button { app.share(.threeMF) } label: { Label("Share 3MF (named, coloured parts)", systemImage: "square.stack.3d.up") }
                    } label: { Image(systemName: "square.and.arrow.up") }
                    .disabled(!app.canExport)
                    .accessibilityLabel("Share the model for printing")
                    Button { showParts = true } label: { Image(systemName: "square.3.layers.3d") }
                        .disabled(app.console?.ok != true)
                        .accessibilityLabel("Parts")
                    Menu {
                        Section("View") {
                            Button { app.preview.resetView(plate: app.plate) } label: { Label("Reset view", systemImage: "scope") }
                            ForEach(Agent.views, id: \.self) { v in Button(v.capitalized) { app.preview.frame(view: v) } }
                        }
                        Toggle("Wireframe", isOn: Binding(get: { app.preview.wireframe }, set: { app.preview.wireframe = $0; app.objectWillChange.send() }))
                        Menu("Plate") {
                            Picker("Plate", selection: Binding(get: { app.plate?.id ?? "none" }, set: { id in
                                if id == "custom" { customPlate = true } else { app.choosePlate(id) }
                            })) {
                                ForEach(Plate.presets, id: \.id) { p in Text(p.label).tag(p.id) }
                            }
                        }
                        Button { renderViews = true } label: { Label("Render views…", systemImage: "photo.on.rectangle.angled") }
                            .disabled(app.console?.ok != true)
                    } label: { Image(systemName: "cube") }
                    .accessibilityLabel("View, wireframe, plate and render")
                    Button { expanded.toggle() } label: {
                        Image(systemName: expanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                    }
                    .accessibilityLabel(expanded ? "Back to the chat" : "Show the 3D view on its own")
                }
                .buttonStyle(.bordered)
                .padding(10)
            }
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: 6) {
                    if let plate = app.plate, !app.plateFit.fits {
                        Text("Does not fit the \(Plate.presets.first { $0.id == plate.id }?.label.components(separatedBy: " · ").first ?? "plate"): \(app.plateFit.problems.joined(separator: ", "))")
                            .font(.caption2).foregroundStyle(.white)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(Color.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 6))
                    }
                    if !app.buildStatus.isEmpty {
                        Button { showConsole = true } label: {
                            HStack(spacing: 6) {
                                if let warnings = app.console?.messages.filter({ $0.kind == .warning }).count, warnings > 0 {
                                    Label("\(warnings)", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                                }
                                if app.console?.error != nil { Image(systemName: "xmark.octagon.fill").foregroundStyle(.red) }
                                Text(app.buildStatus).foregroundStyle(.primary)
                            }
                            .font(.caption.monospaced())
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 6))
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Shows the build's messages")
                    }
                }
                .padding(10)
            }
            .overlay(alignment: .topLeading) { // last, so the measurement panel draws over the build status
                PointerOverlay(preview: app.preview) {
                    app.preview.addMeasurementToMessage()
                    app.preview.clearMeasure()
                }
            }
    }

    private var chat: some View {
        ChatView(typing: $typing, showSettings: $showSettings, showCode: $showCode)
    }
}
