import SwiftUI

/// Over the preview: the Point and Measure buttons, what to do, and the measurement panel.
struct PointerOverlay: View {
    @ObservedObject var preview: PreviewController
    let addMeasurement: () -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    modeButton(.point, "hand.point.up.left", "Point")
                    modeButton(.measure, "ruler", "Measure")
                }
                if let mode = preview.mode {
                    Text(mode == .point ? "Tap a face to refer to it · tap again to drop it" : "Tap two points · corners snap")
                        .font(.caption)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 6))
                }
            }
            .padding(10)
            if let m = preview.measurePanel {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(m.value).font(.headline.monospacedDigit())
                        Text(m.ends).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Text(m.detail).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    if let gap = m.gap { Text(gap).font(.caption2.bold()) }
                    HStack(spacing: 6) {
                        Button("Add to message", action: addMeasurement).buttonStyle(.borderedProminent)
                        Button("Clear") { preview.clearMeasure() }.buttonStyle(.bordered)
                    }
                    .font(.caption)
                    .controlSize(.mini)
                    .padding(.top, 2)
                }
                .padding(8)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
                .padding(10)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            }
        }
    }

    private func modeButton(_ mode: PointerMode, _ icon: String, _ title: String) -> some View {
        let on = preview.mode == mode
        return Button { preview.mode = on ? nil : mode } label: { Image(systemName: icon) }
            .buttonStyle(.bordered)
            .tint(on ? .accentColor : .primary)
            .background(on ? Color.accentColor.opacity(0.25) : .clear, in: RoundedRectangle(cornerRadius: 8))
            .accessibilityLabel(title)
            .accessibilityAddTraits(on ? .isSelected : [])
    }
}
