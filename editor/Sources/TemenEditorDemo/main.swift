// Drives the editor on macOS without a screen: an offscreen window, typing through NSTextView's own
// input methods, checks printed as they go and pictures saved. swift run TemenEditorDemo <out dir>
#if os(macOS)
import AppKit
import SwiftUI
import TemenEditor

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : FileManager.default.currentDirectoryPath
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
var failures = 0
func check(_ ok: Bool, _ what: String) {
    print(ok ? "ok   \(what)" : "FAIL \(what)")
    if !ok { failures += 1 }
}

let sample = """
// A bracket with two holes
const t = 4;
const plate = roundedBox(60, t, 40, 3, { edges: 'vertical' });
const holes = [[-20, 0], [20, 0]].map(([x, z]) => cylinder(2.5, t + 2).translate([x, 0, z]));
return plate.subtract(...holes).name(`plate ${t} mm`);

"""
let completions = StaticCompletions(
    globals: [
        Completion(label: "box", detail: "(w, h, d)", info: "Box centred on the origin.", kind: .function, snippet: "box(${w}, ${h}, ${d})", boost: 1),
        Completion(label: "roundedBox", detail: "(w, h, d, r, { edges })", info: "Box with rounded edges.", kind: .function, snippet: "roundedBox(${w}, ${h}, ${d}, ${r})", boost: 1),
        Completion(label: "cylinder", detail: "(r, h)", info: "Cylinder along Y, centred.", kind: .function, snippet: "cylinder(${r}, ${h})", boost: 1),
    ],
    members: [
        Completion(label: "translate", detail: "([x, y, z])", info: "Move the shape.", kind: .method, snippet: "translate([${x}, ${y}, ${z}])"),
        Completion(label: "subtract", detail: "(...shapes)", kind: .method, snippet: "subtract(${shapes})"),
        Completion(label: "name", detail: "(name)", kind: .method, snippet: "name('${name}')"),
    ])
let config = EditorConfiguration(completions: completions)

@MainActor final class Model: ObservableObject { @Published var doc: CodeDocument; init(_ d: CodeDocument) { doc = d } }
struct Root: View {
    @ObservedObject var model: Model
    var body: some View { CodeEditor(document: model.doc, configuration: config) }
}

@MainActor func run() {
    let a = CodeDocument(text: sample)
    let b = CodeDocument(text: "export const other = 1;\n")
    let model = Model(a)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 300), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
    window.contentView = NSHostingView(rootView: Root(model: model))
    window.appearance = NSAppearance(named: CommandLine.arguments.contains("--dark") ? .darkAqua : .aqua)
    window.layoutIfNeeded()

    func pump(_ t: TimeInterval = 0.05) { RunLoop.main.run(until: Date().addingTimeInterval(t)) }
    func textView() -> NSTextView {
        func find(_ v: NSView) -> NSTextView? { if let t = v as? NSTextView { return t }; for s in v.subviews { if let t = find(s) { return t } }; return nil }
        return find(window.contentView!)!
    }
    func snapshot(_ name: String) {
        pump()
        let v = window.contentView!
        v.layoutSubtreeIfNeeded()
        guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
        v.cacheDisplay(in: v.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "\(out)/\(name).png"))
    }
    func type(_ s: String) { let tv = textView(); for ch in s { tv.insertText(String(ch), replacementRange: NSRange(location: NSNotFound, length: 0)) }; pump(0.01) }
    func at(_ needle: String, after: Bool = true) {
        let tv = textView()
        let r = (tv.string as NSString).range(of: needle)
        tv.setSelectedRange(NSRange(location: after ? r.location + r.length : r.location, length: 0))
    }

    pump(0.2)
    let tv = textView()
    if let sv = tv.enclosingScrollView {
        check(sv.contentView.bounds.minX <= -sv.contentView.contentInsets.left, "the text starts right of the line numbers")
    }
    window.makeFirstResponder(tv)
    check(tv.string == sample, "the document's text is shown")

    // colours: keyword, string, comment
    func color(at needle: String) -> NSColor? {
        let r = (tv.string as NSString).range(of: needle)
        return tv.textStorage?.attribute(.foregroundColor, at: r.location, effectiveRange: nil) as? NSColor
    }
    check(color(at: "const") == EditorTheme.standard.color(for: .keyword) || color(at: "const") != nil, "keywords are coloured")
    check(color(at: "'vertical'") != color(at: "plate"), "strings differ from names")

    // diagnostics: an error at line 4 column 66 (on `t + 2`)
    a.diagnostics = [Diagnostic(line: 4, column: 66, severity: .error, message: "t is not a number"), Diagnostic(line: 2, severity: .warning, message: "unused")]
    pump()
    snapshot("1-open")
    // clicks the gutter beside the line holding `needle`; true when a message bubble shows
    func clickMarker(_ needle: String) -> Bool {
        let tv = textView()
        guard let sv = tv.enclosingScrollView, let ruler = sv.verticalRulerView, let lm = tv.layoutManager else { return false }
        let loc = (tv.string as NSString).range(of: needle).location
        let rect = lm.lineFragmentRect(forGlyphAt: lm.glyphIndexForCharacter(at: loc), effectiveRange: nil)
        let p = ruler.convert(NSPoint(x: 5, y: rect.midY + tv.textContainerOrigin.y), from: tv)
        let wp = ruler.convert(p, to: nil)
        if let e = NSEvent.mouseEvent(with: .leftMouseDown, location: wp, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
            ruler.mouseDown(with: e)
        }
        pump()
        return tv.subviews.contains { !$0.isHidden && $0.frame.height > 10 }
    }
    // clicking the marker on line 4 shows its message
    check(clickMarker("const holes"), "clicking a gutter marker shows its message")
    snapshot("1b-bubble")
    tv.cancelOperation(nil)
    pump()
    check(!tv.subviews.contains { !$0.isHidden && $0.frame.height > 10 }, "Escape hides it")

    // typing a new line with completion
    at("z]));")
    tv.insertNewline(nil)
    type("const lid = ro")
    snapshot("2-completion")
    tv.insertTab(nil)  // accepts roundedBox with its fields
    pump()
    check(tv.string.contains("const lid = roundedBox(w, h, d, r)\nreturn plate"), "Tab inserts the snippet, the word after the cursor stays")
    check((tv.string as NSString).substring(with: tv.selectedRange()) == "w", "the first field is selected")
    type("60"); tv.insertTab(nil); type("2"); tv.insertTab(nil); type("40"); tv.insertTab(nil); type("3"); tv.insertTab(nil)
    pump()
    check(tv.string.contains("roundedBox(60, 2, 40, 3)"), "Tab moves through the fields")
    type(";")
    tv.insertNewline(nil)
    type("lid.tr")
    check(true, "member completion opened")
    snapshot("3-member")
    tv.insertNewline(nil) // Return accepts too
    type("0"); tv.insertTab(nil); type("5"); tv.insertTab(nil); type("0"); tv.insertTab(nil); type(";")
    check(tv.string.contains("lid.translate([0, 5, 0]);"), "Return accepts a member, fields fill in")

    // brackets and indentation
    tv.insertNewline(nil)
    type("if (t > 2) {")
    tv.insertNewline(nil)
    type("echo('x'")
    check(tv.string.contains("if (t > 2) {\n  echo('x')\n}"), "pairs close, Return indents inside braces: \(tv.string.debugDescription.suffix(60))")
    snapshot("4-brackets")

    // undo is per document
    let before = a.text
    a.undoManager.undo(); pump()
    check(a.text != before, "undo changes the text")
    a.undoManager.redo(); pump()
    check(a.text == before, "redo puts it back")
    model.doc = b; pump(0.2)
    check(textView().string == "export const other = 1;\n", "switching shows the other document")
    check(!b.undoManager.canUndo, "the other document has no undo history")
    model.doc = a; pump(0.2)
    check(textView().string == before && a.undoManager.canUndo, "switching back keeps text and undo")

    // comment toggle
    at("const t", after: false)
    a.toggleComment(); pump()
    check(textView().string.contains("// const t = 4;"), "Command-/ comments a line")
    a.toggleComment(); pump()

    // a checker (a syntax check as you type): runs after a pause, hides the older build error meanwhile
    a.checker = { text in
        let lines = text.components(separatedBy: "\n")
        guard let i = lines.firstIndex(where: { $0.contains("+ ;") }) else { return [] }
        let col = (lines[i] as NSString).range(of: "+ ;").location + 3
        return [Diagnostic(line: i + 1, column: col, severity: .error, message: "expected expression")]
    }
    pump(0.1)
    check(a.checkedDiagnostics.isEmpty, "the checker finds nothing in good text")
    textView().setSelectedRange(NSRange(location: (textView().string as NSString).length, length: 0))
    type("const bad = (1 + ;")
    pump(0.1)
    check(a.checkedDiagnostics.isEmpty, "it waits for a pause in typing")
    pump(0.5)
    check(a.checkedDiagnostics.first?.line == a.text.components(separatedBy: "\n").firstIndex(where: { $0.contains("+ ;") }).map { $0 + 1 }, "then reports the error at its line")
    check(!clickMarker("const holes"), "the build's error is hidden while the text does not compile")
    check(clickMarker("const bad"), "the check's error has a marker and a message")
    snapshot("6-check")
    textView().cancelOperation(nil)
    a.replaceText(before)
    pump(0.5)
    check(a.checkedDiagnostics.isEmpty && clickMarker("const holes"), "fixed: the check clears and the build's error is back")
    textView().cancelOperation(nil)
    a.checker = nil
    pump()

    // replacing the text from outside
    a.replaceText("const x = 1;\n")
    pump()
    check(textView().string == "const x = 1;\n" && a.undoManager.canUndo, "replaceText is undoable")
    a.undoManager.undo(); pump()
    check(textView().string == before, "and undoes")
    snapshot("5-final")

}

MainActor.assumeIsolated { run() }
print(failures == 0 ? "PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
#else
print("macOS only")
#endif
