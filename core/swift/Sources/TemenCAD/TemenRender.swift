// The render sheet, by the core: labelled views of parts as PNG, the web app's picture pixel for pixel.
//
//     let png = try core.render(parts: result.parts, views: ["iso", "top", "front", "right"], annotations: result.annotations)
import CTemenCore
import Foundation

public struct TemenRenderError: Error, Sendable, CustomStringConvertible {
    public let message: String
    public var description: String { message }
}

extension TemenCore {
    public static let viewNames = ["iso", "top", "bottom", "front", "back", "left", "right"]

    /// A sheet of the views (tiled; `width` x `height` is one view) with view titles and sizes, part names, a
    /// scale bar and axes when `labels`; ghost parts translucent; hidden parts left out. `section` cuts every
    /// part open at that plane (axis "x", "y" or "z"; keeps coordinates <= value) and paints the cut faces.
    public func render(parts: [TemenPart], views: [String] = ["iso"], width: Int = 480, height: Int = 360, labels: Bool = true,
                       ghosts: Bool = true, section: (axis: String, value: Double)? = nil, annotations: [String] = []) throws -> Data {
        let axis = section.flatMap { ["x", "y", "z"].firstIndex(of: $0.axis) }
        if section != nil && axis == nil { throw TemenRenderError(message: "section axis must be x, y or z") }
        var error: UnsafePointer<CChar>?
        var length = 0
        let viewList = strdup(views.joined(separator: ","))!
        defer { free(viewList) }
        let annC = annotations.map { strdup($0)! }
        defer { annC.forEach { free($0) } }
        let buffer: UnsafeMutableRawPointer? = TemenExport.withCParts(parts) { cParts in
            annC.map { UnsafePointer($0) as UnsafePointer<CChar>? }.withUnsafeBufferPointer { ann in
                var o = TemenRenderOptions(views: UnsafePointer(viewList), width: Int32(width), height: Int32(height), supersample: 2,
                                           labels: labels ? 1 : 0, no_ghosts: ghosts ? 0 : 1, has_section: axis == nil ? 0 : 1,
                                           section_axis: Int32(axis ?? 0), section_value: section?.value ?? 0,
                                           annotations: ann.baseAddress, n_annotations: ann.count)
                return cParts.withUnsafeBufferPointer { temen_render_views(core, $0.baseAddress, $0.count, &o, &length, &error) }
            }
        }
        guard let buffer else { throw TemenRenderError(message: error.map { String(cString: $0) } ?? "the views could not be rendered") }
        defer { temen_buffer_free(buffer) }
        return Data(bytes: buffer, count: length)
    }
}
