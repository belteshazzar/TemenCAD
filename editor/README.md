# TemenEditor

A code editor view for iOS 17+ and macOS 14+, in SwiftUI. It has:

- syntax highlighting that updates as you type
- line numbers
- completion with snippet fields
- diagnostics marked inline, and a checker that runs as you type
- bracket and quote pairs, auto-indent and comment toggling
- bracket and word matching
- the system find bar
- an undo history per document

It contains nothing specific to TemenCAD: the app supplies the language, the completion entries and the diagnostics. A JavaScript subset is built in (the one [lamassu](../third_party/lamassu-js) runs). The package lives in `editor/` in the TemenCAD repository for now and depends on nothing else there, so it can move to its own repository unchanged.

## Using it

```swift
import SwiftUI
import TemenEditor

struct ScriptView: View {
    @StateObject var doc = CodeDocument(text: "const plate = box(40, 4, 30);\n")

    var body: some View {
        CodeEditor(document: doc, configuration: EditorConfiguration(
            completions: StaticCompletions(
                globals: [Completion(label: "box", detail: "(w, h, d)", info: "A box.", kind: .function, snippet: "box(${w}, ${h}, ${d})")],
                members: [Completion(label: "translate", detail: "(x, y, z)", kind: .method, snippet: "translate(${x}, ${y}, ${z})")])))
    }
}
```

- **`CodeDocument`** is one file. It holds:
  - `text`, which is published and updates on every edit
  - `diagnostics`, which are set from your build
  - `selectedRange`
  - its own `undoManager`

  Keep one document per file and pass a different one to `CodeEditor` to switch files. Each file keeps its undo history, selection and scroll position. Other methods:
  - `replaceText(_:undoable:)`, for when the file changed elsewhere (it replaces only the part that
    differs, so the rest keeps its diagnostics and the cursor)
  - `reveal(line:column:)`
  - `showFind(replace:)`
  - `focus()`
  - `complete()`
  - `toggleComment()`
  - `indent(outdent:)`
- **`Diagnostic`** has a 1-based line, an optional column and length, a severity (error, warning or info) and a message. It shows as:
  - a dot in the gutter
  - a dotted underline in the text
  - a bubble with the message when you tap or click the dot

  Diagnostics follow edits until you set new ones.
- **`checker`** on a document checks the text as it is typed, such as a syntax check: an async
  function from the text to diagnostics. It runs `checkDelay` seconds (0.35) after the last edit, off
  the main actor, and a result for text that has changed since is dropped. Its messages show with
  `diagnostics` and are published as `checkedDiagnostics`. While it reports an error, the errors in
  `diagnostics` are hidden: they come from a build of text that has changed since, or are the same
  error. Warnings stay.
- **`EditorConfiguration`** sets:
  - `language` (any `CodeLanguage`; the default is `JavaScriptSubset`)
  - `theme`
  - `completions` (any `CompletionSource`)
  - `editing` (the indent unit; whether to close brackets)
  - `showsLineNumbers`, `highlightsCurrentLine`, `isEditable`
  - `wrapsLines` (macOS only; iOS always wraps)
  - `showsSymbolBar` (iOS: a row of code symbols, Tab, undo and redo above the keyboard)
- **`EditorTheme.standard`** follows light and dark appearance. In light mode it uses CodeMirror's default highlight colours, as the TemenCAD web app does; in dark mode it uses One Dark. Change any colour or the font. Give the theme a new `name` to make the editor redraw.

## Behaviour

**Completion**
- The list opens as you type a name or a dot. Control-Space opens it, and so does Escape on the Mac.
- Matching is fuzzy: `rB` finds `roundedBox`.
- The list shows the signature and the selected entry's description.
- Tab or Return accepts an entry. On iOS you can also tap it.
- A snippet's fields (`${name}`) are selected in turn with Tab and Shift-Tab. A final stop after the closing bracket ends the snippet.
- With `JavaScriptSubset`, the language adds its keywords and the names the document declares (`let`, `const`, functions and their parameters, destructuring). It offers nothing inside strings, comments or numbers, or for a name being declared.

**Editing**
- Brackets and quotes close themselves, and typing the closer steps over it.
- Typing an opener with a selection wraps the selection.
- Backspace deletes an empty pair together, and removes one level of indentation when the cursor is in the indentation.
- Return keeps the indentation and adds a level after an opener. Between an empty pair it puts the closer on its own line.
- A closing brace typed on an empty line goes back to its opener's indentation.
- Tab inserts spaces to the next stop. With a selection it indents the lines; Shift-Tab outdents.
- ⌘] and ⌘[ indent and outdent; ⌘/ comments or uncomments the lines.

**Matching**
- The bracket at the cursor and its partner are highlighted, in red when they don't match.
- Selecting a name highlights its other uses.

**Find**
- ⌘F opens the system find bar (`UIFindInteraction` on iOS, `NSTextFinder` on macOS).

## How it is built

**The text views.** It uses `UITextView` and `NSTextView` on TextKit 1. Line geometry is exact there, which the gutter, the current line and the popups rely on. The system views handle input methods, dictation, accessibility, selection and find. The two views are thin: `UIKit/` and `AppKit/` hold one text view and one SwiftUI wrapper each.

**The shared engine.** Everything else is shared, in `Core/`:
- `EditorEngine` ties the parts to the text view.
- `JavaScriptSubset` is the tokenizer and the completion context.
- `EditingRules` holds the editing behaviour as pure functions of the text, the selection and the tokens.
- `Highlighter` re-colours only the span whose tokens changed.
- `Drawing.swift` draws the gutter, the completion list and the bubble identically on both platforms.

**Edits are undoable.** Edits the editor makes in place of typing go through the text view's undoable path, so the system undo menu, ⌘Z and the undo gestures all work.

**One view per document.** A document keeps its text view while it exists. Switching files swaps views rather than reloading text, which is what keeps each file's undo history and scroll position.

**Adding a language.** Implement `CodeLanguage`:
- `tokenize`
- `lineComment`
- `completionContext`
- `languageCompletions`

## Testing

```sh
xcodebuild test -scheme TemenEditor-Package -destination 'platform=macOS'   # tokenizer, rules, completion, snippets
swift build && .build/debug/TemenEditorDemo /tmp/shots [--dark]           # the macOS editor in an offscreen window
xcodebuild -scheme TemenEditor -destination 'generic/platform=iOS Simulator' build
```

The demo program types into the real `NSTextView` through its own input methods. It covers:
- completion and snippet fields
- member completion
- brackets and indentation
- diagnostics and the bubble
- the checker: waiting for a pause, hiding the older build error, clearing when fixed
- undo per document
- comment toggling
- `replaceText`

It prints a line for each check and saves pictures along the way. (`swift test` does not find the test target with Xcode 16.0 on this machine; `xcodebuild test` runs it.)

## Not yet

- Code folding.
- Hover information.
- Linked snippet fields (the same name in two places edited together).
- A minimap.
- Highlighting the word under the cursor without a selection.
- Horizontal scrolling on iOS (it always wraps).
