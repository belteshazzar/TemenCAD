import SwiftUI

/// Chat with the 3D preview: on a phone in portrait the preview sits on top; on a phone in landscape and on
/// iPad it sits beside the chat. The preview can be expanded to the whole screen.
struct ContentView: View {
    @EnvironmentObject var app: AppModel
    @State private var expanded = false
    @State private var showSettings = false
    @State private var showCode = false
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
        .sheet(item: $app.sharing) { file in
            ShareSheet(url: file.url).presentationDetents([.medium, .large]).ignoresSafeArea()
        }
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
                    Menu {
                        ForEach(Agent.views, id: \.self) { v in Button(v.capitalized) { app.preview.frame(view: v) } }
                    } label: { Image(systemName: "cube") }
                    Button { expanded.toggle() } label: {
                        Image(systemName: expanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                    }
                    .accessibilityLabel(expanded ? "Back to the chat" : "Show the 3D view on its own")
                }
                .buttonStyle(.bordered)
                .padding(10)
            }
            .overlay(alignment: .bottomLeading) {
                if !app.buildStatus.isEmpty {
                    Text(app.buildStatus)
                        .font(.caption.monospaced())
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 6))
                        .padding(10)
                }
            }
    }

    private var chat: some View {
        ChatView(typing: $typing, showSettings: $showSettings, showCode: $showCode)
    }
}
