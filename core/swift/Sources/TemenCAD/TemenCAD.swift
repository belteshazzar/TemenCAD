// TemenCAD for Swift: a thin, safe wrapper over the C core (include/temencad.h).
//
//     let core = try TemenCore()
//     let result = core.build(files: ["main.js": Data("return box(10).onPlate()".utf8)])
//     for part in result.parts { print(part.name, part.volume, part.positions.count / 3, "vertices") }
//
// A TemenCore is single-threaded: use it from one thread or a serial queue. Parts, messages and the
// error are copied out of the core when a build finishes, so they stay valid after the next build.
import CTemenCore
import Foundation

/// One built part: a triangle mesh in millimetres, Y up, with the name and colour the script gave it.
public struct TemenPart: Sendable {
    public let name: String
    public let named: Bool
    public let color: String
    public let ghost: Bool
    public let hidden: Bool
    public let volume: Double
    /// x, y, z per vertex.
    public let positions: [Float]
    /// three vertex indices per triangle.
    public let indices: [UInt32]

    /// The same part shown differently (the app's part display: hidden, or a translucent reference).
    public func displayed(hidden: Bool, ghost: Bool) -> TemenPart {
        TemenPart(name: name, named: named, color: color, ghost: ghost, hidden: hidden, volume: volume, positions: positions, indices: indices)
    }
}

/// A log line or a warning the script produced, with the script file and line when known.
public struct TemenMessage: Sendable {
    public enum Kind: Sendable { case log, warning }
    public let kind: Kind
    public let text: String
    public let file: String?
    public let line: Int?
}

/// A failed build: the message and the script location, as the app shows it.
public struct TemenBuildError: Error, Sendable {
    public let message: String
    public let file: String?
    public let line: Int?
}

/// The printer profile a script declared with printer().
public struct TemenPrinterProfile: Sendable {
    public let nozzle: Double
    public let layer: Double
    public let holeCompensation: Double
    public let material: String?
}

/// Everything one build produced.
public struct TemenBuildResult: Sendable {
    public let parts: [TemenPart]
    public let messages: [TemenMessage]
    /// JSON records from dimension() and mark(), in script order.
    public let annotations: [String]
    public let profile: TemenPrinterProfile?
    public let error: TemenBuildError?
    public let milliseconds: Double
    public var ok: Bool { error == nil }
}

/// The modelling runtime. Create one and build projects with it; each build starts from a clean script state.
public final class TemenCore {
    let core: OpaquePointer // internal: TemenRender.swift draws with it
    private var messages: [TemenMessage] = []

    public init() throws {
        guard let c = temen_new() else { throw TemenBuildError(message: "the TemenCAD core could not start", file: nil, line: nil) }
        core = c
        temen_set_message_fn(core, { ud, kind, text, file, line in
            let me = Unmanaged<TemenCore>.fromOpaque(ud!).takeUnretainedValue()
            me.messages.append(TemenMessage(kind: kind == TEMEN_WARN ? .warning : .log,
                                            text: text.map { String(cString: $0) } ?? "",
                                            file: file.map { String(cString: $0) },
                                            line: line > 0 ? Int(line) : nil))
        }, Unmanaged.passUnretained(self).toOpaque())
    }

    deinit { temen_free(core) }

    /// Version strings of the engine and kernel.
    public static var version: String { String(cString: temen_version()) }

    /// Build a project: `files` maps project paths ("main.js", "parts/lid.js", "Logo.ttf", "photo.png") to their bytes.
    public func build(files: [String: Data]) -> TemenBuildResult {
        messages.removeAll()
        // Keep every buffer alive and pinned for the duration of the run.
        let names = files.keys.sorted()
        let datas = names.map { files[$0]! }
        var cNames: [UnsafeMutablePointer<CChar>] = names.map { strdup($0)! }
        defer { cNames.forEach { free($0) } }
        var status: Int32 = 0
        withPinned(datas) { pointers in
            var entries: [TemenFile] = []
            for (i, name) in cNames.enumerated() {
                entries.append(TemenFile(name: UnsafePointer(name), data: pointers[i].0, len: pointers[i].1))
            }
            status = entries.withUnsafeBufferPointer { temen_run(core, $0.baseAddress, entries.count) }
        }
        let ms = temen_last_run_ms(core)
        if status != 0 {
            let file = temen_error_file(core).map { String(cString: $0) }
            let line = Int(temen_error_line(core))
            let err = TemenBuildError(message: String(cString: temen_error(core)), file: file, line: line > 0 ? line : nil)
            return TemenBuildResult(parts: [], messages: messages, annotations: [], profile: nil, error: err, milliseconds: ms)
        }
        var parts: [TemenPart] = []
        for i in 0..<temen_part_count(core) {
            let p = temen_part(core, i)!.pointee
            parts.append(TemenPart(
                name: String(cString: p.name), named: p.named != 0, color: String(cString: p.color),
                ghost: p.ghost != 0, hidden: p.hidden != 0, volume: p.volume,
                positions: Array(UnsafeBufferPointer(start: p.positions, count: Int(p.n_verts) * 3)),
                indices: Array(UnsafeBufferPointer(start: p.indices, count: Int(p.n_tris) * 3))))
        }
        var annotations: [String] = []
        for i in 0..<temen_annotation_count(core) { annotations.append(String(cString: temen_annotation(core, i))) }
        let prof = temen_profile(core)!.pointee
        let profile = prof.declared != 0 ? TemenPrinterProfile(nozzle: prof.nozzle, layer: prof.layer, holeCompensation: prof.hole_compensation,
                                                               material: prof.material.map { String(cString: $0) }) : nil
        return TemenBuildResult(parts: parts, messages: messages, annotations: annotations, profile: profile, error: nil, milliseconds: ms)
    }

    /// Convenience: one script as main.js.
    public func build(script: String) -> TemenBuildResult { build(files: ["main.js": Data(script.utf8)]) }

    /// Calls `body` with a stable (pointer, length) per Data, all pinned at once.
    private func withPinned(_ datas: [Data], _ body: ([(UnsafeRawPointer?, Int)]) -> Void) {
        func recurse(_ i: Int, _ acc: [(UnsafeRawPointer?, Int)]) {
            if i == datas.count { body(acc); return }
            datas[i].withUnsafeBytes { raw in recurse(i + 1, acc + [(raw.baseAddress, raw.count)]) }
        }
        recurse(0, [])
    }
}
