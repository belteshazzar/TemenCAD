import SwiftUI

/// A text file of the project, editable: the assistant writes them, but they stay the user's. Build saves
/// the change and rebuilds. Opened from the Files sheet.
struct CodeView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.dismiss) private var dismiss
    let file: String
    @State private var text = ""
    @State private var edited = false

    var body: some View {
        TextEditor(text: $text)
            .font(.system(.footnote, design: .monospaced))
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .onChange(of: text) { _, _ in edited = text != (app.project.text(file) ?? "") }
            .navigationTitle(file)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Build") {
                        app.project.files[file] = Data(text.utf8)
                        Task { await app.rebuild() }
                        dismiss()
                    }
                    .disabled(!edited)
                }
            }
            .onAppear { text = app.project.text(file) ?? "" }
    }
}
