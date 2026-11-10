import SwiftUI

/// Render views… (the web app's dialog): a labelled sheet of chosen views, optionally cut open, as a PNG to
/// look at and share. The core draws it, the same picture as the web app and the command line.
struct RenderViewsView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var chosen: Set<String> = ["iso", "top", "front", "right"]
    @State private var axis = ""            // "", "y", "x", "z"
    @State private var value = 0.0
    @State private var size = "960x720"
    @State private var labels = true
    @State private var image: Data?
    @State private var error: String?
    @State private var busy = false
    @State private var sharing: SharedFile?

    static let order: [(id: String, label: String)] = [("iso", "Isometric"), ("top", "Top"), ("front", "Front"), ("right", "Right"),
                                                       ("left", "Left"), ("back", "Back"), ("bottom", "Bottom")]

    var body: some View {
        NavigationStack {
            Form {
                if let image, let ui = UIImage(data: image) {
                    Section {
                        Image(uiImage: ui).resizable().scaledToFit()
                        Button { share(image) } label: { Label("Share PNG", systemImage: "square.and.arrow.up") }
                    }
                }
                Section("Views") {
                    ForEach(Self.order, id: \.id) { v in
                        Toggle(v.label, isOn: Binding(get: { chosen.contains(v.id) }, set: { on in if on { chosen.insert(v.id) } else { chosen.remove(v.id) } }))
                    }
                }
                Section("Section") {
                    Picker("Cut", selection: $axis) {
                        Text("None").tag("")
                        Text("Cut above y =").tag("y")
                        Text("Cut beyond x =").tag("x")
                        Text("Cut beyond z =").tag("z")
                    }
                    if !axis.isEmpty {
                        HStack {
                            Text("At (mm)")
                            Spacer()
                            TextField("0", value: $value, format: .number).keyboardType(.numbersAndPunctuation)
                                .multilineTextAlignment(.trailing).frame(maxWidth: 120)
                        }
                    }
                }
                Section {
                    Picker("Size of each view", selection: $size) {
                        Text("720 × 540").tag("720x540")
                        Text("960 × 720").tag("960x720")
                        Text("1280 × 960").tag("1280x960")
                    }
                    Toggle("Labels, scale bar and axes", isOn: $labels)
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Render views")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Rendering…" : "Render") { Task { await render() } }.disabled(chosen.isEmpty || busy)
                }
            }
            .sheet(item: $sharing) { f in ShareSheet(url: f.url).presentationDetents([.medium, .large]).ignoresSafeArea() }
            #if DEBUG
            .onAppear { if app.debugSheet == "render" { axis = "y"; value = 3; Task { await render() } } } // -TemenThen render
            #endif
        }
    }

    private func render() async {
        busy = true; error = nil
        defer { busy = false }
        let views = Self.order.map(\.id).filter { chosen.contains($0) }
        let wh = size.split(separator: "x").compactMap { Int($0) }
        do {
            image = try await app.renderSheet(views: views, width: wh[0], height: wh[1], labels: labels, section: axis.isEmpty ? nil : (axis, value))
        } catch let e { error = "\(e)" }
    }

    private func share(_ png: Data) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(app.project.fileStem)-views.png")
        do { try png.write(to: url, options: .atomic); sharing = SharedFile(url: url) } catch let e { error = "\(e)" }
    }
}
