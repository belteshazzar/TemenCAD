import Foundation

/// Printer build plates, as in the web app's src/plate.js: [id, label, size in mm (width X, depth Z, height Y)].
struct Plate: Codable, Equatable {
    let id: String
    let w: Double, d: Double, h: Double

    static let presets: [(id: String, label: String, size: [Double]?)] = [
        ("none", "None", nil),
        ("bambu-a1mini", "Bambu A1 mini · 180×180×180", [180, 180, 180]),
        ("bambu-a1", "Bambu A1 / P1 / X1 · 256×256×256", [256, 256, 256]),
        ("prusa-mini", "Prusa MINI+ · 180×180×180", [180, 180, 180]),
        ("prusa-mk4", "Prusa MK4S · 250×210×220", [250, 210, 220]),
        ("prusa-core", "Prusa CORE One · 250×220×270", [250, 220, 270]),
        ("ender3", "Creality Ender-3 · 220×220×250", [220, 220, 250]),
        ("k1", "Creality K1 · 220×220×250", [220, 220, 250]),
        ("neptune4", "Elegoo Neptune 4 · 225×225×265", [225, 225, 265]),
        ("voron350", "Voron 2.4 350 · 350×350×340", [350, 350, 340]),
        ("custom", "Custom…", nil),
    ]

    /// What does not fit (fitProblems in plate.js): empty when the bounds fit the plate, centred on the
    /// origin at y = 0.
    func problems(min lo: [Double], max hi: [Double], eps: Double = 1e-3) -> [String] {
        var over: [String] = []
        let width = hi[0] - lo[0], depth = hi[2] - lo[2], height = hi[1]
        let f = { (v: Double) in String(format: "%.1f", v) }
        if lo[0] < -w / 2 - eps || hi[0] > w / 2 + eps { over.append(width > w + eps ? "\(f(width - w)) mm too wide (X)" : "off the plate in X") }
        if lo[2] < -d / 2 - eps || hi[2] > d / 2 + eps { over.append(depth > d + eps ? "\(f(depth - d)) mm too deep (Z)" : "off the plate in Z") }
        if height > h + eps { over.append("\(f(height - h)) mm too tall (Y)") }
        if lo[1] < -eps { over.append("\(f(-lo[1])) mm below the plate") }
        return over
    }

    var json: JSONValue { ["id": .string(id), "size": [.number(w), .number(d), .number(h)]] }
}

/// An error the app reports to the assistant or the user, as a plain message.
struct AppError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}
