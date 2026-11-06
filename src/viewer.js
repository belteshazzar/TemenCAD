import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf7f6f2);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
    this.camera.up.set(0, 1, 0);
    this.plate = null;
    this.modelGroup = new THREE.Group();
    this.resetView();

    // Mouse: left = rotate, right = pan, wheel = zoom (scale)
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.screenSpacePanning = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9aa8, 1.0));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(5, 10, 7);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-6, -3, -4);
    this.scene.add(fill);

    this.grid = new THREE.GridHelper(20, 20, 0xb8b4ac, 0xe0ddd5);
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(2);
    this.scene.add(this.axes);

    this.scene.add(this.modelGroup);
    this.wireframe = false;

    this.plateGroup = new THREE.Group();
    this.scene.add(this.plateGroup);
    this.plate = null;

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    this.renderer.setAnimationLoop(() => this.render());
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas.parentElement;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Frame the build plate if one is set, otherwise the model, from the default direction. */
  resetView() {
    let box = null;
    if (this.plate) {
      const { w, d, h } = this.plate;
      box = new THREE.Box3(new THREE.Vector3(-w / 2, 0, -d / 2), new THREE.Vector3(w / 2, h, d / 2));
    } else {
      box = this.visibleBounds?.() ?? null;
    }
    if (!box || box.isEmpty()) box = new THREE.Box3(new THREE.Vector3(-100, 0, -100), new THREE.Vector3(100, 100, 100));
    // Look at the centre of the print area on the plate surface (the origin), as the original view did.
    this.frame(box, 0.6, this.plate ? new THREE.Vector3(0, 0, 0) : undefined);
  }

  /**
   * Swing the camera to a preset direction, keeping the current target and distance.
   * Directions are in our Y-up frame; the blue plate edge marks the front (+Z).
   */
  setView(name) {
    const dirs = {
      iso: [8, 7, 10], top: [0, 1, 0.0001], bottom: [0, -1, 0.0001],
      front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0],
    };
    const d = dirs[name];
    if (!d) return;
    const target = this.controls ? this.controls.target.clone() : new THREE.Vector3();
    const dist = this.camera.position.distanceTo(target);
    const dir = new THREE.Vector3(...d).normalize();
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.camera.lookAt(target);
    if (this.controls) this.controls.update();
  }

  /** Move the camera along the default view direction so `box` fits in view, looking at `target`. */
  frame(box, margin = 0.6, target) {
    const center = target ?? box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const fov = Math.min(vFov, hFov);
    const dist = (radius * margin) / Math.sin(fov / 2);
    const dir = new THREE.Vector3(8, 7, 10).normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.01, dist / 1000);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(center);
    if (this.controls) { this.controls.target.copy(center); this.controls.update(); }
  }

  setWireframe(on) {
    this.wireframe = on;
    this.modelGroup.traverse((o) => { if (o.isMesh) o.material.wireframe = on; });
  }

  /**
   * Replace the displayed model. Each entry is
   * { positions, indices?, color, name?, ghost?, visible? }.
   */
  setMeshes(meshes) {
    this.clear();
    meshes.forEach((m, i) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      if (m.indices) geometry.setIndex(new THREE.BufferAttribute(m.indices, 1));
      // Flat shading computes face normals in the shader, so shared vertices stay crisp.
      const mat = new THREE.MeshStandardMaterial({
        color: m.color, roughness: 0.55, metalness: 0.1, flatShading: true,
        wireframe: this.wireframe, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.userData = { index: i, name: m.name ?? `Part ${i + 1}`, ghost: false };
      this.modelGroup.add(mesh);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 30),
        new THREE.LineBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.35 }),
      );
      mesh.add(edges);
      this.updatePart(i, { ghost: !!m.ghost, visible: m.visible !== false });
    });
    // Scale the grid to the model size
    const box = new THREE.Box3().setFromObject(this.modelGroup);
    if (!box.isEmpty()) {
      const size = box.getSize(new THREE.Vector3()).length();
      const g = Math.max(10, Math.pow(10, Math.ceil(Math.log10(size))));
      this.grid.scale.setScalar(g / 20);
    }
  }

  /**
   * Show a printer build plate: { w, d, h } in mm centred on the origin, or null to remove it.
   * Draws the plate surface at y = 0 with a 10 mm grid and the printable volume as a wire box.
   */
  setPlate(plate) {
    for (const o of [...this.plateGroup.children]) { o.geometry?.dispose(); o.material?.dispose(); this.plateGroup.remove(o); }
    this.plate = plate;
    this.grid.visible = !plate;
    this.axes.visible = !plate;
    if (!plate) return;
    const { w, d, h } = plate;
    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshBasicMaterial({ color: 0xdcd9d0, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
    );
    surface.rotation.x = -Math.PI / 2;
    surface.position.y = -0.02;
    this.plateGroup.add(surface);

    // 10 mm grid, heavier line every 50 mm
    const minor = [], major = [];
    const step = 10;
    for (let x = -w / 2; x <= w / 2 + 1e-6; x += step) (Math.round(x) % 50 === 0 ? major : minor).push(x, 0, -d / 2, x, 0, d / 2);
    for (let z = -d / 2; z <= d / 2 + 1e-6; z += step) (Math.round(z) % 50 === 0 ? major : minor).push(-w / 2, 0, z, w / 2, 0, z);
    for (const [pts, color, opacity] of [[minor, 0xb8b4ac, 0.5], [major, 0x8f8b83, 0.7]]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.plateGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity })));
    }

    // Printable volume outline; its color reflects the fit check.
    const volume = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
      new THREE.LineBasicMaterial({ color: 0x6b6b6b, transparent: true, opacity: 0.6 }),
    );
    volume.position.y = h / 2;
    this.plateGroup.add(volume);
    this.plateOutline = volume;

    // Front edge marker so orientation is obvious
    const front = new THREE.BufferGeometry();
    front.setAttribute('position', new THREE.Float32BufferAttribute([-w / 2, 0.01, d / 2, w / 2, 0.01, d / 2], 3));
    this.plateGroup.add(new THREE.LineSegments(front, new THREE.LineBasicMaterial({ color: 0x0b6fcf, linewidth: 2 })));
    this.setPlateFit(true);
  }

  setPlateFit(ok) {
    if (!this.plateOutline) return;
    this.plateOutline.material.color.set(ok ? 0x6b6b6b : 0xc0392b);
    this.plateOutline.material.opacity = ok ? 0.6 : 0.95;
  }

  /** Bounding box of visible, non-ghost parts (null if none). */
  visibleBounds() {
    const box = new THREE.Box3();
    let any = false;
    for (const m of this.modelGroup.children) {
      if (!m.isMesh || !m.visible || m.userData.ghost) continue;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld));
      any = true;
    }
    return any ? box : null;
  }

  /** Change a part's display state without rebuilding geometry. */
  updatePart(index, { ghost, visible } = {}) {
    const mesh = this.modelGroup.children[index];
    if (!mesh) return;
    if (visible !== undefined) mesh.visible = visible;
    if (ghost !== undefined) {
      mesh.userData.ghost = ghost;
      const mat = mesh.material;
      mat.transparent = ghost; mat.opacity = ghost ? 0.25 : 1; mat.depthWrite = !ghost;
      mat.needsUpdate = true;
      const edges = mesh.children[0];
      if (edges) edges.material.opacity = ghost ? 0.12 : 0.35;
    }
  }

  clear() {
    for (const m of [...this.modelGroup.children]) {
      m.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this.modelGroup.remove(m);
    }
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
