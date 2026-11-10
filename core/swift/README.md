# TemenCAD for Swift

The TemenCAD modelling core — the lamassu JavaScript engine, Manifold and the TemenCAD API in one C
library — as a Swift package for macOS and iOS. A script that builds in the web app builds here too,
with the same parts, the same messages and the same error lines.

```swift
import TemenCAD

let core = try TemenCore()
let result = core.build(files: [
    "main.js": Data("import { lid } from './lid.js'; return { body: box(40, 20, 30).onPlate(), lid: lid() }".utf8),
    "lid.js": Data("export const lid = () => box(40, 2, 30).translate(0, 25, 0)".utf8),
])
if let error = result.error {
    print("\(error.file ?? "main.js"):\(error.line ?? 0): \(error.message)")
} else {
    for part in result.parts {
        // part.positions: x, y, z per vertex (Y up, millimetres); part.indices: three per triangle
        print(part.name, part.volume, part.positions.count / 3, "vertices")
    }
    for m in result.messages where m.kind == .warning { print("warning", m.file ?? "", m.line ?? 0, m.text) }
}
```

Mesh buffers go straight into a `SCNGeometry` (SceneKit) or a `MeshResource` (RealityKit); the
annotations are the JSON records `dimension()` and `mark()` produce, and `profile` is the printer
profile the script declared.

`.temen` projects (plain zips) open and save without a `TemenCore`, with the web app's rules:

```swift
let opened = try TemenArchive.readProject(data)   // .files for build(files:), .extras = the .assistant/ entries
let saved = try TemenArchive.write(opened.files.merging(opened.extras) { file, _ in file })
```

Pointing and measuring (the iOS app's Point and Measure) use the core's surface finder, the same words
as the web app:

```swift
let picker = TemenPicker(part)!                                  // once per part mesh
let s = picker.surface(triangle: hit.faceIndex, point: tapped)   // s.label, s.description, s.triangles
let m = TemenPicker.measure(.init(picker: picker, triangle: t1, point: p1, snapped: false),
                            .init(picker: picker, triangle: t2, point: p2, snapped: true))  // m.distance, m.gap, m.text
```

STL and 3MF come from the core too, the same bytes the web app writes:

```swift
let printable = result.parts.filter { !$0.ghost && !$0.hidden }
let stl = try TemenExport.stl(printable)         // one binary solid, Z up
let threeMF = try TemenExport.threeMF(printable) // named, coloured objects, Z up
```

## Building the binary

The C library is shipped to Swift as `TemenCore.xcframework`, built from the CMake project one
level up:

```sh
core/swift/build-xcframework.sh            # macOS (arm64 + x86_64), iOS arm64, iOS simulator (arm64 + x86_64)
core/swift/build-xcframework.sh macos      # one slice, enough for `swift test` on a Mac
cd core/swift && swift test
```

It needs Xcode (for the SDKs, `libtool` and `xcodebuild -create-xcframework`) and CMake 3.24 or
later; the first configure fetches Clipper2. Each slice compiles the core, lamassu, Manifold and
Clipper2 into static libraries and merges them into one `libTemenCAD.a`; the framework carries
`temencad.h` with a module map, so the Swift target does `import CTemenCore`. The framework is not
committed (see `.gitignore`); build it, or publish it as a release asset and point a
`binaryTarget(url:checksum:)` at it for consumers of the package.

## Notes

- A `TemenCore` is single-threaded: use it from one thread or a serial queue. Several instances are
  independent.
- Each build starts from a clean script state (the engine context is rebuilt), and results are copied
  out, so they stay valid after the next build.
- The whole runtime is C and C++ with no platform dependence beyond `clock_gettime`; there is no
  JavaScript engine from the system involved, so App Store rules on downloaded code do not apply
  beyond the usual: the scripts are the user's own and remain visible and editable.
