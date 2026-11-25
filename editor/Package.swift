// swift-tools-version: 5.9
//
// TemenEditor — a code editor view for iOS and macOS: syntax highlighting, line numbers, inline
// diagnostics, completion with snippets, bracket handling, per-document undo and the system find bar.
// It knows nothing about TemenCAD: the app supplies the language (a JavaScript subset is built in),
// the completion entries and the diagnostics.
import PackageDescription

let package = Package(
    name: "TemenEditor",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "TemenEditor", targets: ["TemenEditor"]),
    ],
    targets: [
        .target(name: "TemenEditor"),
        .executableTarget(name: "TemenEditorDemo", dependencies: ["TemenEditor"]),
        .testTarget(name: "TemenEditorTests", dependencies: ["TemenEditor"]),
    ]
)
