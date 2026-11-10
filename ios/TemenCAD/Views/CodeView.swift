import SwiftUI

/// The model's script files, readable and editable. The assistant writes them, but they stay the user's:
/// open, change, and build them here.
struct CodeView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var file = Project.entry
    @State private var text = ""
    @State private var edited = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if app.project.names.filter(Project.isText).count > 1 {
                    Picker("File", selection: $file) {
                        ForEach(app.project.names.filter(Project.isText), id: \.self) { Text($0).tag($0) }
                    }
                    .pickerStyle(.segmented).padding(8)
                }
                TextEditor(text: $text)
                    .font(.system(.footnote, design: .monospaced))
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .onChange(of: text) { _, _ in edited = text != (app.project.text(file) ?? "") }
            }
            .navigationTitle(file)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
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
            .onChange(of: file) { _, f in text = app.project.text(f) ?? "" }
        }
    }
}
