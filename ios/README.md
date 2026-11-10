# TemenCAD for iPhone and iPad

The chat-first TemenCAD app: describe a part in the chat, the assistant writes the model script, the
TemenCAD core builds it on the device, and a live 3D preview shows the result. On a phone in portrait
the preview sits above the chat; in landscape and on iPad it sits beside it. ⤢ shows the preview on its
own. The scripts stay visible and editable (the `</>` button), so the user can always see and change
what runs.

## Build and run

```sh
core/swift/build-xcframework.sh          # once (and after core changes): TemenCore.xcframework with the iOS slices
open ios/TemenCAD.xcodeproj              # scheme TemenCADApp; pick a simulator or your device
```

The project uses Xcode 16 synchronized folders: every file under `ios/TemenCAD/` is part of the app,
so adding a Swift file needs no project edit. The core comes in as the local Swift package
`core/swift` (product `TemenCAD`). For a device, set your team under Signing & Capabilities and change
the bundle identifier (`com.temencad.app`) to one you own.

On first launch the app asks for an Anthropic API key (kept in the Keychain on this device; requests go
straight from the device to api.anthropic.com, billed to the key's account).

## What is in the app

- `App/MainApp.swift` the app entry; `Model/AppModel.swift` the state: the project, builds, the preview
  and the conversation, kept on disk in Application Support (`Current/files/`, `Current/chat.json`).
- `.temen` files: Open… and Save as .temen… in the ⋯ menu, and opening one from Files, AirDrop or another
  app (Info.plist declares the `com.temencad.project` type). Reading and writing is the core's
  (`TemenArchive` in the Swift package, miniz underneath), with the web app's rules. A conversation the web
  app saved in the file is not shown (the two apps keep conversations differently) but is kept and
  written back on save (`Current/extras/`).
- STL and 3MF: the share button on the 3D view, Share STL… / Share 3MF… in the ⋯ menu, and STL / 3MF
  buttons under the latest reply. The core writes the files (`TemenExport`, the same bytes as the web
  app) from the visible, non-ghost parts, and the system share sheet sends them on: a slicer app,
  AirDrop to a Mac, Save to Files.
- `Model/ModelBuilder.swift` builds on the native core (`TemenCore` in an actor: it is single-threaded) and
  makes the build report the assistant reads, in the same shape as the web app's.
- `Agent/AnthropicClient.swift` the Messages API over HTTP with server-sent events (there is no official
  Swift SDK). The message is rebuilt from the stream with every block kept as JSON, so thinking blocks and
  their signatures go back to the API unchanged, as it requires.
- `Agent/Agent.swift` the assistant: system prompt, tools (read / edit / write / remove a script, build,
  screenshot) and the tool loop. Opus 5.5 by default, adaptive thinking at medium effort, the system
  prompt cached, refusal fallbacks on, eager input streaming on the tools.
- `Views/` SwiftUI: the adaptive layout, the chat, settings and the code sheet; `ModelPreview.swift` is the
  SceneKit preview (flat-shaded parts, ghosts, grid, orbit, snapshots for the assistant).
- `Resources/api.txt` and `Resources/assistant-rules.txt` are copies of what the web assistant uses:
  the API reference (generated from `api.html`) and the modelling rules (`src/assistant-rules.txt`).
  Run `ios/scripts/sync-resources.sh` after changing either and commit the copies.

## Developing without spending tokens

Debug builds read three launch arguments, so the app can be driven against a stand-in API on the Mac
(the simulator shares its network; Info.plist allows local networking only):

```sh
xcrun simctl launch booted com.temencad.app \
  -TemenAPIBase http://127.0.0.1:8787 -TemenAPIKey sk-test -TemenAutoPrompt "make a plate with a hole"
```

`-TemenAPIBase` points the client at another server, `-TemenAPIKey` supplies a key, and
`-TemenAutoPrompt` sends a message at launch; `-TemenOpen /path/a.temen` opens a project and
`-TemenSaveTo /path/b.temen` saves it, without the system file sheets (the simulator can read and write
the Mac's paths); `-TemenShare stl` (or `3mf`) exports and opens the share sheet. None of them exist in release builds.

## Not yet

Pointing at faces and measuring, photo attachments, undo per reply, more than one project, showing a
conversation saved by the web app, the plate and printer
profile, and a Mac or visionOS build. SceneKit is the preview for now: Apple has stopped adding features
to it in favour of RealityKit, and everything SceneKit touches is in `Views/ModelPreview.swift`, so moving
is contained.
