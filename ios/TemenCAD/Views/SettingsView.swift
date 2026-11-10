import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var key = ""
    @State private var model = Agent.defaultModel

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("sk-ant-…", text: $key).textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { Text("Anthropic API key") } footer: {
                    Text("The assistant calls the Anthropic API directly from this device with your own key. The key is kept in this device's Keychain and sent only to api.anthropic.com. Usage is billed to your Anthropic account.")
                }
                Section("Model") {
                    Picker("Model", selection: $model) {
                        ForEach(Agent.models, id: \.id) { Text($0.label).tag($0.id) }
                    }
                    .pickerStyle(.inline).labelsHidden()
                }
                Section { LabeledContent("Modelling core", value: TemenCoreVersion.string) }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { app.apiKey = key.trimmingCharacters(in: .whitespacesAndNewlines); app.model = model; dismiss() }
                }
            }
            .onAppear { key = app.apiKey; model = app.model }
        }
    }
}

import TemenCAD
enum TemenCoreVersion { static var string: String { TemenCore.version } }
