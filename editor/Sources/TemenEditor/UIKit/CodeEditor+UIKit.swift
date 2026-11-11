#if canImport(UIKit)
import SwiftUI
import UIKit

/// The editor as a SwiftUI view. Pass a different document to switch files; each keeps its own undo
/// history, selection and scroll position.
public struct CodeEditor: UIViewRepresentable {
    let document: CodeDocument
    let configuration: EditorConfiguration

    public init(document: CodeDocument, configuration: EditorConfiguration = .init()) {
        self.document = document
        self.configuration = configuration
    }

    public func makeUIView(context: Context) -> EditorContainerView {
        let c = EditorContainerView()
        c.show(document.editorView(configuration))
        return c
    }

    public func updateUIView(_ view: EditorContainerView, context: Context) {
        view.show(document.editorView(configuration))
    }
}

/// Holds the current document's text view.
public final class EditorContainerView: UIView {
    func show(_ v: UIView) {
        guard v.superview !== self else { return }
        subviews.forEach { $0.removeFromSuperview() }
        v.frame = bounds
        v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(v)
    }
}
#endif
