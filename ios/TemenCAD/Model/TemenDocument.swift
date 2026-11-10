import SwiftUI
import UniformTypeIdentifiers

/// The bytes of a .temen, for SwiftUI's save sheet (fileExporter).
struct TemenDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.temenProject] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
        guard let d = configuration.file.regularFileContents else { throw CocoaError(.fileReadCorruptFile) }
        data = d
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
