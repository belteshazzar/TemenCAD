import SceneKit
import SwiftUI
import TemenCAD
import UIKit

/// Pointing and measuring in the preview (the web app's src/pointer.js): .point taps a face, hole or
/// fillet to refer to it in the next message; .measure taps two points (corners snap).
enum PointerMode: Equatable { case point, measure }

/// Something picked in the view, waiting in the composer as a chip.
struct ViewReference: Identifiable, Equatable {
    enum Kind { case surface, measurement }
    let id: Int
    let kind: Kind
    let label: String
    let text: String
    var colorName: String? = nil
    var color: UIColor? = nil
}

/// What the measurement panel shows.
struct MeasurePanel: Equatable {
    let value: String, detail: String, gap: String?, ends: String
    let label: String, text: String
}

/// The 3D preview: the built parts in a SceneKit view the user can spin, zoom and pan with their fingers.
/// Everything SceneKit-specific lives here, so moving to RealityKit later touches this file only.
@MainActor
final class PreviewController: NSObject, ObservableObject {
    let view: SCNView = {
        let v = SCNView()
        v.scene = SCNScene()
        v.backgroundColor = UIColor(red: 0.969, green: 0.965, blue: 0.949, alpha: 1)
        v.allowsCameraControl = true
        v.defaultCameraController.interactionMode = .orbitTurntable
        v.defaultCameraController.inertiaEnabled = true
        v.antialiasingMode = .multisampling4X
        v.autoenablesDefaultLighting = false
        return v
    }()
    private let modelNode = SCNNode()
    private let gridNode = SCNNode()
    private let cameraNode = SCNNode()
    private var framed = false
    private var bounds: (SCNVector3, SCNVector3)?

    // pointing and measuring
    @Published var mode: PointerMode? { didSet { if mode != .measure, measureEnds.count == 1 { clearMeasure() } } }
    @Published private(set) var measurePanel: MeasurePanel?
    /// A face was picked (a chip goes in the composer), or dropped by tapping it again.
    var onReference: ((ViewReference) -> Void)?
    var onReferenceRemoved: ((Int) -> Void)?
    private let overlayNode = SCNNode()
    private var shownParts: [TemenPart] = []
    private var pickers: [Int: TemenPicker] = [:]
    private struct Pick { let id: Int; let part: Int; let triangles: Set<Int>; let colorName: String; let nodes: [SCNNode] }
    private var picks: [Pick] = []
    private struct MeasureEnd { let part: Int; let triangle: Int; let point: SIMD3<Double>; let snapped: Bool }
    private var measureEnds: [MeasureEnd] = []
    private var measureNodes: [SCNNode] = []
    private var nextID = 1
    static let colors: [(String, UIColor)] = [
        ("orange", UIColor(red: 1, green: 0.541, blue: 0, alpha: 1)), ("magenta", UIColor(red: 0.878, green: 0.188, blue: 0.541, alpha: 1)),
        ("teal", UIColor(red: 0, green: 0.639, blue: 0.639, alpha: 1)), ("purple", UIColor(red: 0.478, green: 0.298, blue: 1, alpha: 1)),
        ("green", UIColor(red: 0.18, green: 0.62, blue: 0.243, alpha: 1)), ("red", UIColor(red: 0.851, green: 0.169, blue: 0.169, alpha: 1)),
    ]
    static let snapPoints: CGFloat = 12 // a tap this close to a corner (on screen) lands on it

    override init() {
        super.init()
        let scene = view.scene!
        cameraNode.camera = SCNCamera()
        cameraNode.camera?.fieldOfView = 45
        cameraNode.camera?.zNear = 0.1
        cameraNode.camera?.zFar = 10000
        scene.rootNode.addChildNode(cameraNode)
        view.pointOfView = cameraNode

        let ambient = SCNNode(); ambient.light = SCNLight(); ambient.light?.type = .ambient
        ambient.light?.intensity = 450; ambient.light?.color = UIColor(white: 1, alpha: 1)
        let key = SCNNode(); key.light = SCNLight(); key.light?.type = .directional; key.light?.intensity = 900
        key.eulerAngles = SCNVector3(-0.9, 0.5, 0)
        let fill = SCNNode(); fill.light = SCNLight(); fill.light?.type = .directional; fill.light?.intensity = 300
        fill.eulerAngles = SCNVector3(0.6, -2.4, 0)
        for n in [ambient, key, fill, modelNode, gridNode, overlayNode] { scene.rootNode.addChildNode(n) }
        setGrid(size: 100)
        frame(view: "iso")
        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))
    }

    /// Show a build's parts (hidden parts skipped, ghosts translucent). The first build frames the camera.
    func show(_ result: TemenBuildResult?) {
        guard let result, result.ok else { return }
        modelNode.childNodes.forEach { $0.removeFromParentNode() }
        // new geometry: picks and the measurement referred to the old mesh, so they go (chips stay in the composer)
        clearPicks(notify: false)
        clearMeasure()
        pickers = [:]
        shownParts = result.parts
        var lo = SCNVector3(Float.infinity, .infinity, .infinity), hi = SCNVector3(-Float.infinity, -.infinity, -.infinity)
        for (index, part) in result.parts.enumerated() where !part.hidden {
            let node = SCNNode(geometry: Self.geometry(part))
            node.name = "part:\(index)"
            modelNode.addChildNode(node)
            if part.ghost { continue }
            var i = 0
            while i + 2 < part.positions.count {
                lo = SCNVector3(min(lo.x, part.positions[i]), min(lo.y, part.positions[i + 1]), min(lo.z, part.positions[i + 2]))
                hi = SCNVector3(max(hi.x, part.positions[i]), max(hi.y, part.positions[i + 1]), max(hi.z, part.positions[i + 2]))
                i += 3
            }
        }
        if lo.x != .infinity {
            bounds = (lo, hi)
            setGrid(size: CGFloat(max(hi.x - lo.x, hi.z - lo.z, 20)) * 2)
            if !framed { frame(view: "iso"); framed = true }
        }
    }

    /// Flat-shaded triangles: each triangle gets its own vertices with the face normal, so edges stay crisp.
    static func geometry(_ part: TemenPart) -> SCNGeometry {
        let p = part.positions, idx = part.indices
        var verts = [SCNVector3](), normals = [SCNVector3]()
        verts.reserveCapacity(idx.count); normals.reserveCapacity(idx.count)
        var t = 0
        while t + 2 < idx.count {
            let a = Int(idx[t]) * 3, b = Int(idx[t + 1]) * 3, c = Int(idx[t + 2]) * 3
            let va = SIMD3<Float>(p[a], p[a + 1], p[a + 2]), vb = SIMD3<Float>(p[b], p[b + 1], p[b + 2]), vc = SIMD3<Float>(p[c], p[c + 1], p[c + 2])
            let n = simd_normalize(simd_cross(vb - va, vc - va))
            let nn = n.x.isNaN ? SIMD3<Float>(0, 1, 0) : n
            for v in [va, vb, vc] { verts.append(SCNVector3(v)); normals.append(SCNVector3(nn)) }
            t += 3
        }
        let geo = SCNGeometry(sources: [SCNGeometrySource(vertices: verts), SCNGeometrySource(normals: normals)],
                              elements: [SCNGeometryElement(indices: Array(0..<Int32(verts.count)), primitiveType: .triangles)])
        let m = SCNMaterial()
        m.lightingModel = .physicallyBased
        m.diffuse.contents = UIColor(hex: part.color) ?? UIColor(red: 0.45, green: 0.56, blue: 0.82, alpha: 1)
        m.roughness.contents = 0.55
        m.metalness.contents = 0.1
        m.isDoubleSided = true
        if part.ghost { m.transparency = 0.25; m.writesToDepthBuffer = false }
        geo.materials = [m]
        return geo
    }

    private func setGrid(size: CGFloat) {
        gridNode.childNodes.forEach { $0.removeFromParentNode() }
        let step = pow(10, floor(log10(size / 2)))
        let half = (size / 2 / step).rounded(.up) * step
        var pts = [SCNVector3](), ind = [Int32]()
        var x = -half
        while x <= half + 0.001 {
            for (a, b) in [(SCNVector3(Float(x), 0, Float(-half)), SCNVector3(Float(x), 0, Float(half))),
                           (SCNVector3(Float(-half), 0, Float(x)), SCNVector3(Float(half), 0, Float(x)))] {
                ind.append(Int32(pts.count)); pts.append(a); ind.append(Int32(pts.count)); pts.append(b)
            }
            x += step
        }
        let geo = SCNGeometry(sources: [SCNGeometrySource(vertices: pts)], elements: [SCNGeometryElement(indices: ind, primitiveType: .line)])
        let m = SCNMaterial(); m.lightingModel = .constant; m.diffuse.contents = UIColor(white: 0.84, alpha: 1)
        geo.materials = [m]
        gridNode.addChildNode(SCNNode(geometry: geo))
    }

    /// Point the camera from a preset direction with the model filling the view.
    func frame(view name: String) {
        let dirs: [String: SIMD3<Float>] = ["iso": [8, 7, 10], "top": [0, 1, 0.0001], "bottom": [0, -1, 0.0001],
                                            "front": [0, 0, 1], "back": [0, 0, -1], "left": [-1, 0, 0], "right": [1, 0, 0]]
        let dir = simd_normalize(dirs[name] ?? dirs["iso"]!)
        let (lo, hi) = bounds ?? (SCNVector3(-20, 0, -20), SCNVector3(20, 20, 20))
        let center = SIMD3<Float>((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2)
        let radius = max(simd_length(SIMD3<Float>(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z)) / 2, 1)
        let aspect = Float(max(view.bounds.width, 1) / max(view.bounds.height, 1))
        let vfov = Float(45 * Double.pi / 180), hfov = 2 * atan(tan(vfov / 2) * aspect)
        let dist = radius * 1.15 / sin(min(vfov, hfov) / 2)
        cameraNode.simdPosition = center + dir * dist
        cameraNode.simdLook(at: center, up: [0, 1, 0], localFront: [0, 0, -1])
        view.pointOfView = cameraNode
        view.defaultCameraController.target = SCNVector3(center)
    }

    // MARK: - Pointing and measuring

    private var modelRadius: Float {
        guard let (lo, hi) = bounds else { return 20 }
        return max(simd_length(SIMD3<Float>(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z)) / 2, 1)
    }

    private func picker(_ part: Int) -> TemenPicker? {
        if let p = pickers[part] { return p }
        guard shownParts.indices.contains(part), let p = TemenPicker(shownParts[part]) else { return nil }
        pickers[part] = p
        return p
    }

    @objc private func tapped(_ g: UITapGestureRecognizer) {
        guard g.state == .ended else { return }
        tap(at: g.location(in: view))
    }

    /// A tap in the view at `loc` (points), in the current mode.
    func tap(at loc: CGPoint) {
        guard let mode else { return }
        let hits = view.hitTest(loc, options: [.searchMode: SCNHitTestSearchMode.all.rawValue, .rootNode: modelNode, .ignoreHiddenNodes: true])
            .filter { $0.node.name?.hasPrefix("part:") == true }
        // solid parts before ghosts
        guard let hit = hits.first(where: { !(shownParts[partIndex($0.node)].ghost) }) ?? hits.first else { return }
        let part = partIndex(hit.node), tri = hit.faceIndex
        let p = hit.localCoordinates
        let point = SIMD3<Double>(Double(p.x), Double(p.y), Double(p.z))
        if mode == .point { togglePick(part: part, triangle: tri, point: point) }
        else { measureTap(part: part, triangle: tri, point: point, at: loc) }
    }

    private func partIndex(_ node: SCNNode) -> Int { Int(node.name?.dropFirst(5) ?? "") ?? 0 }

    private func togglePick(part: Int, triangle: Int, point: SIMD3<Double>) {
        if let existing = picks.first(where: { $0.part == part && $0.triangles.contains(triangle) }) {
            removePick(existing.id)
            onReferenceRemoved?(existing.id)
            return
        }
        guard let surface = picker(part)?.surface(triangle: triangle, point: point) else { return }
        let used = Set(picks.map(\.colorName))
        let (name, color) = Self.colors.first { !used.contains($0.0) } ?? Self.colors[picks.count % Self.colors.count]
        let id = nextID; nextID += 1
        let highlight = highlightNode(part: part, triangles: surface.triangles, color: color)
        let tag = labelNode("", color: color, at: point)
        overlayNode.addChildNode(highlight); overlayNode.addChildNode(tag)
        picks.append(Pick(id: id, part: part, triangles: Set(surface.triangles), colorName: name, nodes: [highlight, tag]))
        renumber()
        onReference?(ViewReference(id: id, kind: .surface, label: surface.label, text: surface.description, colorName: name, color: color))
    }

    /// Drops a pick (its chip was removed from the composer, or it was tapped again).
    func removePick(_ id: Int) {
        guard let i = picks.firstIndex(where: { $0.id == id }) else { return }
        picks[i].nodes.forEach { $0.removeFromParentNode() }
        picks.remove(at: i)
        renumber()
    }

    /// Drops every pick, after a message took them, or when the model changes.
    func clearPicks(notify: Bool = false) {
        for p in picks { p.nodes.forEach { $0.removeFromParentNode() }; if notify { onReferenceRemoved?(p.id) } }
        picks = []
    }

    private func renumber() {
        for (i, p) in picks.enumerated() {
            if let tag = p.nodes.last, let color = Self.colors.first(where: { $0.0 == p.colorName })?.1 {
                tag.geometry = labelNode("\(i + 1)", color: color, at: SIMD3(Double(tag.position.x), Double(tag.position.y), Double(tag.position.z))).geometry
            }
        }
    }

    /// The colours of the picks in composer order ("reference 1 orange, ..."), for the message.
    var pickColors: [Int: String] { Dictionary(uniqueKeysWithValues: picks.map { ($0.id, $0.colorName) }) }

    /// The view as the user sees it, picks highlighted: PNG at most 1024 px wide, for the message.
    func referenceSnapshot() -> Data? {
        let image = view.snapshot()
        let k = min(1, 1024 / max(image.size.width * image.scale, 1))
        let size = CGSize(width: image.size.width * image.scale * k, height: image.size.height * image.scale * k)
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }.pngData()
    }

    /// The picked surface's triangles, lifted a little off the part so they draw over it.
    private func highlightNode(part: Int, triangles: [Int], color: UIColor) -> SCNNode {
        let p = shownParts[part].positions, idx = shownParts[part].indices
        let lift = modelRadius * 0.002
        var verts = [SCNVector3]()
        verts.reserveCapacity(triangles.count * 3)
        for t in triangles {
            let a = Int(idx[3 * t]) * 3, b = Int(idx[3 * t + 1]) * 3, c = Int(idx[3 * t + 2]) * 3
            let va = SIMD3<Float>(p[a], p[a + 1], p[a + 2]), vb = SIMD3<Float>(p[b], p[b + 1], p[b + 2]), vc = SIMD3<Float>(p[c], p[c + 1], p[c + 2])
            var n = simd_normalize(simd_cross(vb - va, vc - va)); if n.x.isNaN { n = .zero }
            for v in [va, vb, vc] { verts.append(SCNVector3(v + n * lift)) }
        }
        let geo = SCNGeometry(sources: [SCNGeometrySource(vertices: verts)],
                              elements: [SCNGeometryElement(indices: Array(0..<Int32(verts.count)), primitiveType: .triangles)])
        let m = SCNMaterial()
        m.lightingModel = .constant
        m.diffuse.contents = color.withAlphaComponent(0.6)
        m.isDoubleSided = true
        m.writesToDepthBuffer = false
        geo.materials = [m]
        let node = SCNNode(geometry: geo)
        node.renderingOrder = 10
        return node
    }

    /// A small label that faces the camera and draws over everything (a pick's number, a distance).
    private func labelNode(_ text: String, color: UIColor, at point: SIMD3<Double>) -> SCNNode {
        let font = UIFont.systemFont(ofSize: 40, weight: .bold)
        let shown = text.isEmpty ? " " : text
        let textSize = (shown as NSString).size(withAttributes: [.font: font])
        let size = CGSize(width: max(textSize.width + 28, 56), height: 56)
        let image = UIGraphicsImageRenderer(size: size).image { _ in
            color.setFill()
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: size.height / 2).fill()
            (shown as NSString).draw(at: CGPoint(x: (size.width - textSize.width) / 2, y: (size.height - textSize.height) / 2),
                                     withAttributes: [.font: font, .foregroundColor: UIColor.white])
        }
        let h = CGFloat(modelRadius * 0.08)
        let plane = SCNPlane(width: h * size.width / size.height, height: h)
        let m = SCNMaterial()
        m.lightingModel = .constant
        m.diffuse.contents = image
        m.readsFromDepthBuffer = false
        m.writesToDepthBuffer = false
        m.isDoubleSided = true
        plane.materials = [m]
        let node = SCNNode(geometry: plane)
        node.position = SCNVector3(Float(point.x), Float(point.y), Float(point.z))
        node.constraints = [SCNBillboardConstraint()]
        node.renderingOrder = 20
        return node
    }

    private func measureTap(part: Int, triangle: Int, point: SIMD3<Double>, at loc: CGPoint) {
        // snap to the tapped triangle's nearest corner when it is within a few points on screen
        let pos = shownParts[part].positions, idx = shownParts[part].indices
        var end = MeasureEnd(part: part, triangle: triangle, point: point, snapped: false)
        var best = Self.snapPoints
        for k in 0..<3 {
            let v = Int(idx[3 * triangle + k]) * 3
            let corner = SCNVector3(pos[v], pos[v + 1], pos[v + 2])
            let s = view.projectPoint(corner)
            let d = hypot(CGFloat(s.x) - loc.x, CGFloat(s.y) - loc.y)
            if d < best { best = d; end = MeasureEnd(part: part, triangle: triangle, point: SIMD3(Double(corner.x), Double(corner.y), Double(corner.z)), snapped: true) }
        }
        if measureEnds.count != 1 { clearMeasure() }
        measureEnds.append(end)
        let dot = SCNNode(geometry: SCNSphere(radius: CGFloat(modelRadius * 0.012)))
        let dm = SCNMaterial(); dm.lightingModel = .constant; dm.diffuse.contents = UIColor(white: 0.1, alpha: 1); dm.readsFromDepthBuffer = false
        dot.geometry?.materials = [dm]
        dot.position = SCNVector3(Float(end.point.x), Float(end.point.y), Float(end.point.z))
        dot.renderingOrder = 30
        overlayNode.addChildNode(dot); measureNodes.append(dot)
        guard measureEnds.count == 2 else { measurePanel = nil; return }
        let a = measureEnds[0], b = measureEnds[1]
        let line = SCNGeometry(sources: [SCNGeometrySource(vertices: [SCNVector3(Float(a.point.x), Float(a.point.y), Float(a.point.z)),
                                                                      SCNVector3(Float(b.point.x), Float(b.point.y), Float(b.point.z))])],
                               elements: [SCNGeometryElement(indices: [Int32(0), 1], primitiveType: .line)])
        line.materials = [dm]
        let lineNode = SCNNode(geometry: line); lineNode.renderingOrder = 30
        overlayNode.addChildNode(lineNode); measureNodes.append(lineNode)
        guard let pa = picker(a.part), let pb = picker(b.part),
              let m = TemenPicker.measure(.init(picker: pa, triangle: a.triangle, point: a.point, snapped: a.snapped),
                                          .init(picker: pb, triangle: b.triangle, point: b.point, snapped: b.snapped)) else { return }
        let r2 = Self.r2
        let tag = labelNode("\(r2(m.distance)) mm", color: UIColor(white: 0.1, alpha: 0.85), at: (a.point + b.point) / 2)
        overlayNode.addChildNode(tag); measureNodes.append(tag)
        let name = { (e: MeasureEnd) in self.shownParts[e.part].name + (e.snapped ? " (corner)" : "") }
        measurePanel = MeasurePanel(value: "\(r2(m.distance)) mm",
                                    detail: "Δx \(r2(m.delta[0])) · Δy \(r2(m.delta[1])) · Δz \(r2(m.delta[2]))",
                                    gap: m.gap.map { "Parallel faces \(r2($0)) mm apart" }, ends: "\(name(a)) → \(name(b))",
                                    label: m.label, text: m.text)
    }

    /// A number as the web app shows it: to 0.01, without trailing zeros.
    static func r2(_ x: Double) -> String {
        var s = String(format: "%.2f", (x * 100 + 0.5).rounded(.down) / 100)
        while s.contains(".") && (s.hasSuffix("0") || s.hasSuffix(".")) { s.removeLast() }
        return s == "-0" ? "0" : s
    }

    /// The measurement as a chip in the composer.
    func addMeasurementToMessage() {
        guard let m = measurePanel else { return }
        let id = nextID; nextID += 1
        onReference?(ViewReference(id: id, kind: .measurement, label: m.label, text: m.text))
    }

    func clearMeasure() {
        measureNodes.forEach { $0.removeFromParentNode() }
        measureNodes = []
        measureEnds = []
        measurePanel = nil
    }

    /// The view as PNG for the assistant (optionally from a preset direction first).
    func snapshot(view name: String?) -> Data? {
        if let name { frame(view: name) }
        return view.snapshot().pngData()
    }
}

struct ModelPreview: UIViewRepresentable {
    let controller: PreviewController
    func makeUIView(context: Context) -> SCNView { controller.view }
    func updateUIView(_ uiView: SCNView, context: Context) {}
}

extension UIColor {
    convenience init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
}
