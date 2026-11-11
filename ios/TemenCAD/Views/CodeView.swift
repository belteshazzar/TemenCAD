import SwiftUI
import TemenEditor

/// A text file of the project in the code editor: highlighting, completion of the API, inline errors from
/// the last build, undo per file. The assistant writes the files, but they stay the user's: Build puts the
/// edits in the project and builds it, and stays here to show an error. Opened from the Files sheet.
struct CodeView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.dismiss) private var dismiss
    let file: String
    @State private var document: CodeDocument?
    @State private var building = false

    var body: some View {
        Group {
            if let document {
                Editor(document: document, file: file, building: $building) { dismiss() }
            } else {
                Color.clear
            }
        }
        .navigationTitle(file)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { document = app.editorDocument(file) }
        .onChange(of: app.project.text(file)) { _, _ in document = app.editorDocument(file) }
    }

    /// The editor and its toolbar; observes the document so Build follows the edits.
    private struct Editor: View {
        @EnvironmentObject var app: AppModel
        @ObservedObject var document: CodeDocument
        let file: String
        @Binding var building: Bool
        let done: () -> Void

        var body: some View {
            CodeEditor(document: document, configuration: EditorSupport.configuration)
                .ignoresSafeArea(.container, edges: .bottom)
                .toolbar {
                    ToolbarItemGroup(placement: .primaryAction) {
                        Button { document.showFind() } label: { Image(systemName: "magnifyingglass") }
                            .accessibilityLabel("Find")
                        Button("Build") { build() }
                            .disabled(building || document.text == (app.project.text(file) ?? ""))
                    }
                }
        }

        private func build() {
            building = true
            Task {
                let result = await app.buildFromEditor(file)
                building = false
                if let e = result?.error {
                    // stay with the error: show it where it is
                    if let line = e.line, (e.file ?? Project.entry) == file { document.reveal(line: line) }
                } else {
                    done()
                }
            }
        }
    }
}
