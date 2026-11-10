import SwiftUI
import TemenCAD

/// The Parts list (the web app's Parts menu): show or hide each part, make it a ghost (a translucent reference
/// that is not exported), solo it, or share it alone as STL. The choices survive rebuilds.
struct PartsView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                let parts = app.lastResult?.parts ?? []
                if parts.isEmpty { Text("No parts yet").foregroundStyle(.secondary) }
                ForEach(Array(parts.enumerated()), id: \.offset) { _, p in row(p) }
            }
            .id(app.displayGeneration)
            .navigationTitle("Parts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Button("Show all") { app.showAllParts(true) }
                        Button("Hide all") { app.showAllParts(false) }
                        Button("As the script says") { app.resetPartDisplay() }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    private func row(_ p: TemenPart) -> some View {
        let f = app.partFlags(p.name)
        return HStack(spacing: 10) {
            Button { app.setPart(p.name, visible: !f.visible) } label: {
                Image(systemName: f.visible ? "eye" : "eye.slash").frame(width: 24)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(f.visible ? "Hide \(p.name)" : "Show \(p.name)")
            Circle().fill(Color(UIColor(hex: p.color) ?? .systemBlue)).frame(width: 12, height: 12)
                .opacity(f.ghost ? 0.35 : 1)
            VStack(alignment: .leading, spacing: 1) {
                Text(p.name).foregroundStyle(f.visible ? .primary : .secondary)
                Text("\(p.indices.count / 3) triangles · \(String(format: "%.1f", p.volume)) mm³").font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            Button("ghost") { app.setPart(p.name, ghost: !f.ghost) }
                .font(.caption).buttonStyle(.bordered).tint(f.ghost ? .accentColor : .secondary)
                .accessibilityLabel(f.ghost ? "Make \(p.name) solid" : "Make \(p.name) a ghost")
            Menu {
                Button { app.solo(p.name) } label: { Label("Solo", systemImage: "scope") }
                Button { app.sharePart(p.name) } label: { Label("Share as STL", systemImage: "square.and.arrow.up") }
            } label: { Image(systemName: "ellipsis") }
            .accessibilityLabel("More for \(p.name)")
        }
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { app.solo(p.name) }
    }
}

/// The last build's messages (the web app's console): the error, warnings with their lines, and log lines.
struct ConsoleView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let r = app.console {
                    if let e = r.error {
                        line(icon: "xmark.octagon.fill", color: .red, text: e.message, place: place(e.file, e.line))
                    }
                    ForEach(Array(r.messages.enumerated()), id: \.offset) { _, m in
                        if m.kind == .warning { line(icon: "exclamationmark.triangle.fill", color: .orange, text: m.text, place: place(m.file, m.line)) }
                        else { Text(m.text).font(.caption.monospaced()).textSelection(.enabled) }
                    }
                    if r.error == nil && r.messages.isEmpty { Text("No messages. \(app.buildStatus).").foregroundStyle(.secondary) }
                } else {
                    Text("Not built yet").foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Console")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { UIPasteboard.general.string = allText } label: { Image(systemName: "doc.on.doc") }
                        .accessibilityLabel("Copy every message")
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    private func place(_ file: String?, _ line: Int?) -> String? {
        guard let line else { return file }
        return "\(file ?? Project.entry):\(line)"
    }

    private func line(icon: String, color: Color, text: String, place: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: icon).foregroundStyle(color)
            VStack(alignment: .leading, spacing: 2) {
                Text(text).font(.callout).textSelection(.enabled)
                if let place { Text(place).font(.caption.monospaced()).foregroundStyle(.secondary) }
            }
        }
    }

    private var allText: String {
        guard let r = app.console else { return "" }
        var lines: [String] = []
        if let e = r.error { lines.append("Error (\(place(e.file, e.line) ?? Project.entry)): \(e.message)") }
        for m in r.messages {
            lines.append(m.kind == .warning ? "Warning\(place(m.file, m.line).map { " (\($0))" } ?? ""): \(m.text)" : m.text)
        }
        return lines.joined(separator: "\n")
    }
}

/// A custom build plate: width (X), depth (Z) and height (Y) in mm.
struct CustomPlateView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var w = 220.0
    @State private var d = 220.0
    @State private var h = 250.0

    var body: some View {
        NavigationStack {
            Form {
                Section("Build volume in mm") {
                    field("Width (X)", $w); field("Depth (Z)", $d); field("Height (Y)", $h)
                }
            }
            .navigationTitle("Custom plate")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Use") { app.choosePlate("custom", size: [w, d, h]); dismiss() }.disabled(!(w > 0 && d > 0 && h > 0))
                }
            }
            .onAppear { if let p = app.plate, p.id == "custom" { w = p.w; d = p.d; h = p.h } }
        }
    }

    private func field(_ title: String, _ value: Binding<Double>) -> some View {
        HStack {
            Text(title)
            Spacer()
            TextField(title, value: value, format: .number).keyboardType(.decimalPad).multilineTextAlignment(.trailing).frame(maxWidth: 120)
        }
    }
}
