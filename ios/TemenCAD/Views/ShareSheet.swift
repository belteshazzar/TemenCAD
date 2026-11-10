import SwiftUI
import UIKit

/// A file for the share sheet.
struct SharedFile: Identifiable {
    let url: URL
    var id: URL { url }
}

/// The system share sheet for a file (UIActivityViewController: AirDrop, Save to Files, other apps).
struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
