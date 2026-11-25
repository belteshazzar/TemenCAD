// swift-tools-version: 5.9
//
// TemenCAD — the modelling core (lamassu-js + Manifold + the TemenCAD API) for Swift on macOS and iOS.
//
// The C library arrives as TemenCore.xcframework, built from the CMake project one level up by
// ./build-xcframework.sh (macOS arm64, iOS arm64, iOS simulator arm64). The Swift target wraps the C
// API in include/temencad.h: build a project, read back parts as mesh buffers, messages with their
// script lines, annotations and the printer profile.
import PackageDescription

let package = Package(
    name: "TemenCAD",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "TemenCAD", targets: ["TemenCAD"]),
    ],
    targets: [
        .binaryTarget(name: "CTemenCore", path: "TemenCore.xcframework"),
        .target(name: "TemenCAD", dependencies: ["CTemenCore"], linkerSettings: [.linkedLibrary("c++")]),
        .testTarget(name: "TemenCADTests", dependencies: ["TemenCAD"]),
    ],
    cxxLanguageStandard: .cxx17
)
