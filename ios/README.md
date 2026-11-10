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
- Photos: the photo button beside the message field attaches up to five photos from the library
  (PhotosPicker, no permission needed) or the camera. Each goes to the assistant as "Attachment n",
  downscaled to 1568 px on the long edge as in the web app, and is kept full size in
  `Current/attachments/n.jpg` so the assistant can put it in the project with `save_attachment` (for a
  lithophane or heightmap). A new chat starts the numbering again.
- Files: the paperclip's Choose Files… (or a drop on the chat, on iPad) attaches PDFs, which go to the
  assistant as document blocks numbered with the photos (kept in `Current/attachments/n.pdf`, up to 30 MB
  per message), and project files (.stl, .svg, .ttf, .otf, scripts), which are added to the project with
  the message, so the reply's Undo takes them out; a chip says when one replaces a file. Images picked
  there go as photos. The assistant can ask for files with `add_files`: a card above the message field
  opens Files and returns the names added.
- Undo per reply: a reply that changed the project gets Undo and Changes buttons and a summary
  (`main.js +4 −3`). Undo first keeps the current state, so the event line it adds can Put back (and then
  Undo again); the assistant is told with the next message (`<app_events>`, as in the web app). Changes
  opens the reply's diff (`Model/Diff.swift`, a port of `src/diff.js` with the same output). Checkpoints
  are file-name → SHA-256 maps kept with the conversation; each file's bytes are stored once in
  `Current/blobs`. A new chat clears them.
- Point and Measure: the two buttons at the top left of the 3D view. Point: tap a face, hole, boss or
  fillet to refer to it ("make this thicker"); it is highlighted in a colour with its number and goes in
  the composer as a chip; tap it again (or remove the chip) to drop it. Measure: tap two points (corners
  within 12 pt snap); the panel shows the distance, |Δx| |Δy| |Δz|, the gap between parallel faces, and
  Add to message. The surface finding and every word sent are the core's (`TemenPicker`), the same as the
  web app's; the message carries a snapshot of the view with the picks highlighted, as on the web.
- Plate, Parts and console: the cube menu has Reset view (the plate filling the view when one is shown, else
  the model, as on the web), the views, Wireframe, Render views… (the web dialog: views, a section, the size of
  each view and labels; the core draws the PNG, which can be shared) and Plate (the web presets or a custom
  size; a red note under the view says what does not fit). The layers button opens the Parts list: show
  or hide each part, make it a ghost, solo it (also a double tap), share it alone as STL, show all, hide
  all, or go back to what the script says; the choices survive rebuilds and decide what is exported, as on
  the web. Tapping the build status (with its warning count) opens the console: the error, warnings with
  their lines, log lines, and Copy. The assistant gets the same state with each message in an `<app>`
  block (the plate and whether the model fits, wireframe, each part's display), as the web assistant does.
- STL and 3MF: the share button on the 3D view, Share STL… / Share 3MF… in the ⋯ menu, and STL / 3MF
  buttons under the latest reply. The core writes the files (`TemenExport`, the same bytes as the web
  app) from the visible, non-ghost parts, and the system share sheet sends them on: a slicer app,
  AirDrop to a Mac, Save to Files.
- `Model/ModelBuilder.swift` builds on the native core (`TemenCore` in an actor: it is single-threaded) and
  makes the build report the assistant reads, in the same shape as the web app's.
- `Agent/AnthropicClient.swift` the Messages API over HTTP with server-sent events (there is no official
  Swift SDK). The message is rebuilt from the stream with every block kept as JSON, so thinking blocks and
  their signatures go back to the API unchanged, as it requires.
- `Agent/Agent.swift` the assistant: system prompt, tools (read / edit / write / remove / rename a script,
  build, screenshot, render_views, save_attachment, export_model, set_view, set_plate, set_part_display)
  and the tool loop. The tools behave as the web assistant's: render_views draws the same sheet (the
  core's renderer); export_model puts the file in the chat with a Share button; set_plate shows a
  printer's plate (red when the model does not fit, `Model/Plate.swift`); set_part_display keeps the web
  Parts list's overrides, which decide what shows and what is exported. Opus 5.5 by default, adaptive thinking at medium effort, the system
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
the Mac's paths); `-TemenShare stl` (or `3mf`) exports and opens the share sheet; `-TemenAttach "/a/photo.jpg|/b/drawing.pdf|/c/bolt.stl"` attaches
those files to the next message as if picked in the chat; `-TemenAddFiles "/a/font.ttf"` answers the assistant's add_files with those files (`none` cancels); `-TemenThen "undo,putback,undoagain,changes"` runs those steps once the turn is over (also `point`, `measure`, `tap:0.5:0.6` at fractions of the view,
`addmeasure`, `send`). None of them exist in release builds.

## Not yet

More than one project, showing a
conversation saved by the web app, the printer profile, and a Mac or visionOS build. SceneKit is the preview for now: Apple has stopped adding features
to it in favour of RealityKit, and everything SceneKit touches is in `Views/ModelPreview.swift`, so moving
is contained.
