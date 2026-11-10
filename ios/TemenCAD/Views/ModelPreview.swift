import SceneKit
import SwiftUI
import TemenCAD
import UIKit

/// The 3D preview: the built parts in a SceneKit view the user can spin, zoom and pan with their fingers.
/// Everything SceneKit-specific lives here, so moving to RealityKit later touches this file only.
@MainActor
final class PreviewController {
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

    init() {
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
        for n in [ambient, key, fill, modelNode, gridNode] { scene.rootNode.addChildNode(n) }
        setGrid(size: 100)
        frame(view: "iso")
    }

    /// Show a build's parts (hidden parts skipped, ghosts translucent). The first build frames the camera.
    func show(_ result: TemenBuildResult?) {
        guard let result, result.ok else { return }
        modelNode.childNodes.forEach { $0.removeFromParentNode() }
        var lo = SCNVector3(Float.infinity, .infinity, .infinity), hi = SCNVector3(-Float.infinity, -.infinity, -.infinity)
        for part in result.parts where !part.hidden {
            let node = SCNNode(geometry: Self.geometry(part))
            node.name = part.name
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
