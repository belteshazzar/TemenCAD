import SwiftUI

/// What a reply changed: per file, a unified diff (text) or the new size (other files).
struct ChangesView: View {
    let title: String
    let changes: [FileChange]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if changes.isEmpty { Text("Nothing to show.").foregroundStyle(.secondary) }
                    ForEach(changes) { c in file(c) }
                }
                .padding()
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    @ViewBuilder
    private func file(_ c: FileChange) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(c.name).font(.subheadline.bold())
                Text(c.status.rawValue).font(.caption).foregroundStyle(.secondary)
                if let d = c.diff {
                    Text("+\(d.added)").font(.caption.monospaced()).foregroundStyle(.green)
                    Text("−\(d.removed)").font(.caption.monospaced()).foregroundStyle(.red)
                } else if let size = c.size {
                    Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)).font(.caption).foregroundStyle(.secondary)
                }
            }
            if let d = c.diff, !d.hunks.isEmpty {
                ScrollView(.horizontal, showsIndicators: true) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(d.hunks.enumerated()), id: \.offset) { _, h in
                            Text(h.header).foregroundStyle(.secondary).padding(.top, 4)
                            ForEach(Array(h.lines.enumerated()), id: \.offset) { _, l in
                                Text(String(l.op) + l.text)
                                    .foregroundStyle(l.op == "+" ? Color.green : l.op == "-" ? Color.red : Color.primary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(l.op == "+" ? Color.green.opacity(0.08) : l.op == "-" ? Color.red.opacity(0.08) : Color.clear)
                            }
                        }
                    }
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
                }
                .padding(8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}
