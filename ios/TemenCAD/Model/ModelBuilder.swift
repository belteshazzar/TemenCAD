import Foundation
import TemenCAD

/// Builds projects on the native TemenCAD core. A TemenCore is single-threaded, so it lives in an actor.
actor ModelBuilder {
    private var core: TemenCore?

    func build(_ project: Project) -> TemenBuildResult? {
        if core == nil { core = try? TemenCore() }
        return core?.build(files: project.files)
    }

    /// The render sheet of built parts (the web app's, pixel for pixel).
    func render(parts: [TemenPart], views: [String], width: Int, height: Int, labels: Bool, section: (axis: String, value: Double)?, annotations: [String]) throws -> Data {
        if core == nil { core = try? TemenCore() }
        guard let core else { throw AppError( "The modelling core could not start.") }
        return try core.render(parts: parts, views: views, width: width, height: height, labels: labels, section: section, annotations: annotations)
    }
}

/// What the assistant reads after a build: the same shape as the web app's build report.
enum BuildReport {
    static func make(_ r: TemenBuildResult?) -> JSONValue {
        guard let r else { return ["ok": false, "error": ["message": "The modelling core could not start."]] }
        let warnings: [JSONValue] = r.messages.filter { $0.kind == .warning }.map { m in
            ["message": .string(m.text), "file": m.file.map(JSONValue.string) ?? .null, "line": m.line.map { .number(Double($0)) } ?? .null]
        }
        let logs: [JSONValue] = r.messages.filter { $0.kind == .log }.map { .string($0.text) }
        if let e = r.error {
            return ["ok": false, "error": ["message": .string(e.message), "file": .string(e.file ?? Project.entry),
                                           "line": e.line.map { .number(Double($0)) } ?? .null],
                    "warnings": .array(warnings), "log": .array(logs)]
        }
        let parts: [JSONValue] = r.parts.map { p in
            let (lo, hi) = bounds(p.positions)
            return ["name": .string(p.name), "volume": .number((p.volume * 100).rounded() / 100),
                    "size": .array(zip(lo, hi).map { .number((($1 - $0) * 100).rounded() / 100) }),
                    "min": .array(lo.map { .number(($0 * 100).rounded() / 100) }), "triangles": .number(Double(p.indices.count / 3)),
                    "ghost": .bool(p.ghost), "hidden": .bool(p.hidden)]
        }
        return ["ok": true, "parts": .array(parts), "warnings": .array(warnings), "log": .array(logs),
                "ms": .number((r.milliseconds * 10).rounded() / 10)]
    }

    /// A number as JS prints it for these captions: no trailing zeros ("5", "2.5").
    static func number(_ v: Double) -> String {
        v == v.rounded() && abs(v) < 1e15 ? String(Int(v)) : String(v)
    }

    static func bounds(_ p: [Float]) -> ([Double], [Double]) {
        var lo = [Double](repeating: .infinity, count: 3), hi = [Double](repeating: -.infinity, count: 3)
        var i = 0
        while i + 2 < p.count {
            for k in 0..<3 { let v = Double(p[i + k]); lo[k] = min(lo[k], v); hi[k] = max(hi[k], v) }
            i += 3
        }
        if lo[0] == .infinity { return ([0, 0, 0], [0, 0, 0]) }
        return (lo, hi)
    }

    /// One line for the chat: "Built 2 parts" or the error with its line.
    static func summary(_ r: TemenBuildResult?) -> String {
        guard let r else { return "The modelling core could not start." }
        if let e = r.error { return "\(e.file ?? Project.entry):\(e.line ?? 0) \(e.message)" }
        let n = r.parts.filter { !$0.hidden && !$0.ghost }.count
        return "Built \(n) part\(n == 1 ? "" : "s") in \(Int(r.milliseconds)) ms"
    }
}
