// Pointing and measuring on a built part, by the core (the web app's words, exactly).
//
//     let picker = TemenPicker(part)                        // once per part mesh
//     let s = picker.surface(triangle: hit.faceIndex, point: hit.point)
//     s?.label         // "lid · Ø6 hole along Y"   (for a chip)
//     s?.description   // a full sentence for the assistant
//     s?.triangles     // every triangle of the face or hole, for highlighting
import CTemenCore
import Foundation

/// The surface a tapped triangle belongs to: a flat face, or a curved one (a hole, boss, fillet, sphere).
public struct TemenSurface: Decodable, Sendable {
    public struct Bounds: Decodable, Sendable { public let min: [Double]; public let max: [Double] }
    public let kind: String            // "flat" | "curved"
    public let shape: String?          // "cylinder" | "sphere" | "surface" when curved
    public let normal: [Double]?       // flat
    public let radius: Double?
    public let convex: Bool?
    public let axis: [Double]?
    public let center: [Double]?
    public let length: Double?
    public let span: Double?           // degrees around the axis: 360 for a hole or boss, less for a fillet
    public let area: Double
    public let bounds: Bounds
    public let centroid: [Double]
    public let label: String
    public let description: String
    public let triangles: [Int]

    enum CodingKeys: String, CodingKey {
        case kind, shape, normal, radius, convex, axis, center, length, span, area, bounds, centroid, label, description
        case triangles = "tris"
    }
}

/// A measurement between two tapped points.
public struct TemenMeasurement: Decodable, Sendable {
    public let distance: Double
    public let delta: [Double]      // |dx|, |dy|, |dz|
    public let gap: Double?         // between two parallel flat faces
    public let label: String        // "Measured 12.5 mm"
    public let text: String         // for the assistant
}

/// One part's mesh topology, for picking surfaces on it. Not thread-safe: use from one thread.
public final class TemenPicker {
    private let pick: OpaquePointer
    public let partName: String

    public init?(_ part: TemenPart) {
        guard let p = part.positions.withUnsafeBufferPointer({ pos in
            part.indices.withUnsafeBufferPointer { idx in
                temen_pick_new(pos.baseAddress, part.positions.count / 3, idx.baseAddress, part.indices.count / 3)
            }
        }) else { return nil }
        pick = p
        partName = part.name
    }
    deinit { temen_pick_free(pick) }

    /// The surface triangle `triangle` belongs to; `point` is where the user tapped (model coordinates).
    public func surface(triangle: Int, point: SIMD3<Double>) -> TemenSurface? {
        guard triangle >= 0 else { return nil }
        var pt = [point.x, point.y, point.z]
        guard let json = temen_pick_surface(pick, triangle, partName, &pt) else { return nil }
        return try? JSONDecoder().decode(TemenSurface.self, from: Data(String(cString: json).utf8))
    }

    /// One end of a measurement.
    public struct End {
        public let picker: TemenPicker, triangle: Int, point: SIMD3<Double>, snapped: Bool
        public init(picker: TemenPicker, triangle: Int, point: SIMD3<Double>, snapped: Bool) {
            self.picker = picker; self.triangle = triangle; self.point = point; self.snapped = snapped
        }
    }

    public static func measure(_ a: End, _ b: End) -> TemenMeasurement? {
        var pa = [a.point.x, a.point.y, a.point.z], pb = [b.point.x, b.point.y, b.point.z]
        guard let json = temen_pick_measure(a.picker.pick, a.triangle, a.picker.partName, &pa, a.snapped ? 1 : 0,
                                            b.picker.pick, b.triangle, b.picker.partName, &pb, b.snapped ? 1 : 0) else { return nil }
        return try? JSONDecoder().decode(TemenMeasurement.self, from: Data(String(cString: json).utf8))
    }
}
