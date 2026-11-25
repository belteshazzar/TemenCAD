#if canImport(AppKit) && !canImport(UIKit)
import SwiftUI
import AppKit

/// The editor as a SwiftUI view. Pass a different document to switch files; each keeps its own undo
/// history, selection and scroll position.
public struct CodeEditor: NSViewRepresentable {
    let document: CodeDocument
    let configuration: EditorConfiguration

    public init(document: CodeDocument, configuration: EditorConfiguration = .init()) {
        self.document = document
        self.configuration = configuration
    }

    public func makeNSView(context: Context) -> EditorContainerView {
        let c = EditorContainerView()
        c.show(document.editorView(configuration).scroll)
        return c
    }

    public func updateNSView(_ view: EditorContainerView, context: Context) {
        view.show(document.editorView(configuration).scroll)
    }
}

/// Holds the current document's scroll view.
public final class EditorContainerView: NSView {
    func show(_ v: NSView) {
        guard v.superview !== self else { return }
        subviews.forEach { $0.removeFromSuperview() }
        v.frame = bounds
        v.autoresizingMask = [.width, .height]
        addSubview(v)
    }

    public override func layout() {
        super.layout()
        ((subviews.first as? NSScrollView)?.documentView as? CodeTextView)?.alignToInsets()
    }
}
#endif
