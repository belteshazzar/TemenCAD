/**
 * Pointing and measuring in the 3D view.
 *   Point:   click a face or a part to refer to it in the next chat message ("make this thicker").
 *            The whole flat face, hole, boss or fillet is highlighted (pick-geometry.js); click it
 *            again to drop it.
 *   Measure: click two points; corners snap. Shows the distance, its X / Y / Z parts and, for two
 *            parallel flat faces, how far apart they are (a wall's thickness).
 * Clicks are told apart from orbit drags by how far the pointer moved. Escape leaves either mode.
 */
import * as THREE from 'three';
import { topology, surfaceAt, shortLabel, describeSurface, parallelGap, fmtPoint } from './pick-geometry.js';

const COLORS = [['orange', 0xff8a00], ['magenta', 0xe0308a], ['teal', 0x00a3a3], ['purple', 0x7a4cff], ['green', 0x2e9e3e], ['red', 0xd92b2b]];
const CLICK_SLOP = 5;   // px the pointer may move and still count as a click
const SNAP_PX = 10;     // a click this close to a corner (on screen) lands on it
const r2 = (x) => { const v = Math.round(x * 100) / 100; return Object.is(v, -0) ? 0 : v; };

export class Pointer {
  /** onReference(ref): a face was picked, ref = { id, kind: 'ref' | 'measure', label, text, color, colorHex } */
  constructor(viewer, { root, onReference }) {
    this.viewer = viewer;
    this.canvas = viewer.canvas;
    this.onReference = onReference;
    this.mode = null;
    this.refs = [];          // picked surfaces waiting in the chat composer
    this.measure = null;     // { a, b, objects: [], labels: [] }
    this.topos = new WeakMap();
    this.raycaster = new THREE.Raycaster();
    this.nextId = 1;

    // toolbar, label layer and the measurement panel
    this.toolbar = Object.assign(document.createElement('div'), { id: 'view-tools' });
    this.toolbar.innerHTML = `
      <button type="button" data-mode="point" title="Point: click a face or part to refer to it in your message to the assistant (Esc to stop)">☝ Point</button>
      <button type="button" data-mode="measure" title="Measure: click two points; corners snap (Esc to stop)">📏 Measure</button>`;
    this.labels = Object.assign(document.createElement('div'), { className: 'view-labels' });
    this.panel = Object.assign(document.createElement('div'), { className: 'measure-panel', hidden: true });
    this.hint = Object.assign(document.createElement('div'), { className: 'view-hint', hidden: true });
    root.append(this.toolbar, this.labels, this.panel, this.hint);
    this.toolbar.addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) this.setMode(this.mode === b.dataset.mode ? null : b.dataset.mode); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.mode) this.setMode(null); });

    let down = null;
    this.canvas.addEventListener('pointerdown', (e) => { if (e.button === 0) down = { x: e.clientX, y: e.clientY }; });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved <= CLICK_SLOP && this.mode) this.click(e);
    });
    let pending = false;
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.mode !== 'point' || pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; this.hover(e); });
    });
    this.canvas.addEventListener('pointerleave', () => this.setHover(null));

    viewer.onFrame.add(() => this.placeLabels());
    viewer.onModelChanged.add(() => this.modelChanged());
  }

  setMode(mode) {
    this.mode = mode;
    for (const b of this.toolbar.querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === mode);
    this.canvas.classList.toggle('pointing', !!mode);
    this.setHover(null);
    this.hint.hidden = !mode;
    this.hint.textContent = mode === 'point' ? 'Click a face or part to refer to it in your message · click it again to drop it · Esc to stop'
      : mode === 'measure' ? 'Click two points to measure · corners snap · Esc to stop' : '';
    if (mode !== 'measure' && this.measure && !this.measure.b) this.clearMeasure();
  }

  // ---- picking ----
  /** The mesh, point and triangle under a pointer event (solid parts before ghosts), or null. */
  pick(e) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.viewer.camera);
    const hits = this.raycaster.intersectObjects(this.viewer.modelGroup.children, false).filter((h) => h.object.isMesh && h.object.visible);
    const hit = hits.find((h) => !h.object.userData.ghost) ?? hits[0];
    if (!hit) return null;
    return { mesh: hit.object, point: hit.point.clone(), tri: hit.faceIndex, screen: { x: e.clientX - r.left, y: e.clientY - r.top } };
  }
  topology(mesh) {
    let t = this.topos.get(mesh);
    if (!t) {
      const g = mesh.geometry; // parts are drawn untransformed, so mesh coordinates are model coordinates
      t = topology(g.attributes.position.array, g.index?.array ?? null);
      this.topos.set(mesh, t);
    }
    return t;
  }
  surface(hit) { return surfaceAt(this.topology(hit.mesh), hit.tri); }

  /** A highlight over the given triangles of a mesh. */
  highlight(mesh, tris, color, opacity = 0.6) {
    const src = mesh.geometry.attributes.position.array, idx = mesh.geometry.index?.array;
    const pos = new Float32Array(tris.length * 9);
    tris.forEach((t, i) => { for (let k = 0; k < 3; k++) { const v = idx ? idx[3 * t + k] : 3 * t + k; pos.set([src[3 * v], src[3 * v + 1], src[3 * v + 2]], 9 * i + 3 * k); } });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.renderOrder = 2;
    this.viewer.overlay.add(m);
    return m;
  }
  dispose(obj) { if (!obj) return; this.viewer.overlay.remove(obj); obj.geometry?.dispose(); obj.material?.dispose(); }

  hover(e) {
    const hit = this.pick(e);
    if (!hit) return this.setHover(null);
    const s = this.surface(hit);
    const key = `${hit.mesh.uuid}:${s.tris[0]}`;
    if (this.hovered?.key === key) return;
    this.setHover({ key, obj: this.highlight(hit.mesh, s.tris, 0x2f6fe4, 0.25) });
    this.canvas.title = shortLabel(hit.mesh.userData.name, s);
  }
  setHover(h) {
    if (this.hovered) this.dispose(this.hovered.obj);
    this.hovered = h;
    if (!h) this.canvas.title = '';
  }

  click(e) {
    const hit = this.pick(e);
    if (this.mode === 'point') { if (hit) this.togglePick(hit); return; }
    if (this.mode === 'measure' && hit) this.measureClick(hit);
  }

  // ---- point ----
  togglePick(hit) {
    const s = this.surface(hit);
    const existing = this.refs.find((r) => r.mesh === hit.mesh && r.surface.tris.includes(hit.tri));
    if (existing) { this.removeRef(existing.id); existing.onRemoved?.(); return; }
    const used = new Set(this.refs.map((r) => r.color)); // the first colour not already on a pick
    const [colorName, colorHex] = COLORS.find(([c]) => !used.has(c)) ?? COLORS[this.refs.length % COLORS.length];
    const part = hit.mesh.userData.name;
    const ref = {
      id: this.nextId++, kind: 'ref', mesh: hit.mesh, surface: s, point: hit.point.toArray(), color: colorName, colorHex,
      label: shortLabel(part, s), text: describeSurface(part, s, hit.point.toArray()),
    };
    ref.obj = this.highlight(hit.mesh, s.tris, colorHex);
    ref.tag = this.addLabel(ref.point, '', colorHex);
    this.refs.push(ref);
    this.renumber();
    this.setHover(null);
    this.onReference({ id: ref.id, kind: 'ref', label: ref.label, text: ref.text, color: colorName, colorHex, setRemoved: (f) => { ref.onRemoved = f; } });
  }
  /** Drop a reference (its chip was removed from the composer, or it was clicked again). */
  removeRef(id) {
    const i = this.refs.findIndex((r) => r.id === id);
    if (i < 0) return;
    const [r] = this.refs.splice(i, 1);
    this.dispose(r.obj); r.tag.remove();
    this.renumber();
  }
  renumber() { this.refs.forEach((r, i) => { r.tag.textContent = String(i + 1); }); }
  /** References in composer order, with their numbers and colours, for the message. */
  referenceOrder() { return this.refs.map((r, i) => ({ id: r.id, n: i + 1, color: r.color })); }
  /** The view as the user sees it, references highlighted, as { mediaType, data } (base64 PNG). */
  snapshot() {
    this.setHover(null);
    const s = this.viewer.snapshot(1024);
    return { mediaType: s.mediaType, data: s.data };
  }
  clearRefs() { for (const r of [...this.refs]) this.removeRef(r.id); }

  // ---- measure ----
  /** Snap to the hit triangle's nearest corner when it is within a few pixels on screen. */
  snap(hit) {
    const g = hit.mesh.geometry, src = g.attributes.position.array, idx = g.index?.array;
    const r = this.canvas.getBoundingClientRect();
    let best = null, bestD = SNAP_PX;
    for (let k = 0; k < 3; k++) {
      const v = idx ? idx[3 * hit.tri + k] : 3 * hit.tri + k;
      const p = new THREE.Vector3(src[3 * v], src[3 * v + 1], src[3 * v + 2]);
      const s = p.clone().project(this.viewer.camera);
      const d = Math.hypot((s.x + 1) / 2 * r.width - hit.screen.x, (1 - s.y) / 2 * r.height - hit.screen.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best ? { point: best, snapped: true } : { point: hit.point, snapped: false };
  }
  measureClick(hit) {
    const { point, snapped } = this.snap(hit);
    const end = { point, snapped, part: hit.mesh.userData.name, surface: this.surface(hit) };
    if (!this.measure || this.measure.b) { this.clearMeasure(); this.measure = { a: end, objects: [], labels: [] }; }
    else this.measure.b = end;
    const m = this.measure;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0x1a1a1a, depthTest: false }));
    dot.position.copy(point); dot.renderOrder = 3; dot.userData.marker = true;
    this.viewer.overlay.add(dot); m.objects.push(dot);
    this.sizeMarkers();
    if (!m.b) { this.panel.hidden = true; return; }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([m.a.point, m.b.point]), new THREE.LineBasicMaterial({ color: 0x1a1a1a, depthTest: false }));
    line.renderOrder = 3;
    this.viewer.overlay.add(line); m.objects.push(line);
    const d = m.a.point.distanceTo(m.b.point);
    m.labels.push(this.addLabel(m.a.point.clone().lerp(m.b.point, 0.5).toArray(), `${r2(d)} mm`, null, 'measure-tag'));
    this.showPanel();
  }
  measurement() {
    const { a, b } = this.measure;
    const d = a.point.distanceTo(b.point), delta = b.point.clone().sub(a.point).toArray().map((x) => Math.abs(x));
    const gap = parallelGap(a.surface, b.surface);
    return { d, delta, gap };
  }
  showPanel() {
    const { a, b } = this.measure, { d, delta, gap } = this.measurement();
    const end = (e) => `${e.part}${e.snapped ? ' (corner)' : ''}`;
    this.panel.innerHTML = '';
    const big = Object.assign(document.createElement('div'), { className: 'measure-value', textContent: `${r2(d)} mm` });
    const parts = Object.assign(document.createElement('div'), { className: 'measure-detail', textContent: `Δx ${r2(delta[0])} · Δy ${r2(delta[1])} · Δz ${r2(delta[2])}` });
    const ends = Object.assign(document.createElement('div'), { className: 'measure-detail', textContent: `${end(a)} → ${end(b)}` });
    this.panel.append(big, parts);
    if (gap !== null) this.panel.appendChild(Object.assign(document.createElement('div'), { className: 'measure-detail strong', textContent: `Parallel faces ${r2(gap)} mm apart` }));
    this.panel.appendChild(ends);
    const row = Object.assign(document.createElement('div'), { className: 'measure-actions' });
    const add = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Add to message', title: 'Tell the assistant about this measurement in your next message' });
    add.addEventListener('click', () => this.onReference({ id: this.nextId++, kind: 'measure', label: `Measured ${r2(d)} mm`, text: this.describeMeasurement() }));
    const clear = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary', textContent: 'Clear' });
    clear.addEventListener('click', () => this.clearMeasure());
    row.append(add, clear);
    this.panel.appendChild(row);
    this.panel.hidden = false;
  }
  describeMeasurement() {
    const { a, b } = this.measure, { d, delta, gap } = this.measurement();
    const end = (e) => `${fmtPoint(e.point.toArray())} on part "${e.part}"${e.snapped ? ' (a corner)' : ''}, ${shortLabel(e.part, e.surface).split(' · ')[1]}`;
    return `from ${end(a)} to ${end(b)}: ${r2(d)} mm (|Δx| ${r2(delta[0])}, |Δy| ${r2(delta[1])}, |Δz| ${r2(delta[2])})${gap !== null ? `; the two faces are parallel and ${r2(gap)} mm apart` : ''}`;
  }
  clearMeasure() {
    if (!this.measure) return;
    for (const o of this.measure.objects) this.dispose(o);
    for (const l of this.measure.labels) l.remove();
    this.measure = null;
    this.panel.hidden = true;
  }
  /** Keep the measurement dots a few pixels wide whatever the zoom. */
  sizeMarkers() {
    if (!this.measure) return;
    const cam = this.viewer.camera, h = this.canvas.clientHeight || 1;
    for (const o of this.measure.objects) if (o.userData.marker) {
      const dist = cam.position.distanceTo(o.position);
      o.scale.setScalar(Math.max(1e-3, 3 * (2 * dist * Math.tan((cam.fov * Math.PI) / 360)) / h));
    }
  }

  // ---- labels over the view ----
  addLabel(point, text, colorHex, cls = 'ref-tag') {
    const el = Object.assign(document.createElement('div'), { className: cls, textContent: text });
    if (colorHex !== null && colorHex !== undefined) el.style.background = `#${colorHex.toString(16).padStart(6, '0')}`;
    el.dataset.point = JSON.stringify(point);
    this.labels.appendChild(el);
    return el;
  }
  placeLabels() {
    if (!this.labels.children.length) return;
    this.sizeMarkers();
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    for (const el of this.labels.children) {
      const p = new THREE.Vector3(...JSON.parse(el.dataset.point)).project(this.viewer.camera);
      el.style.transform = `translate(${(p.x + 1) / 2 * w}px, ${(1 - p.y) / 2 * h}px) translate(-50%, -50%)`;
      el.hidden = p.z > 1;
    }
  }

  /** New geometry: picks and measurements refer to the old mesh, so they go (chips stay in the composer). */
  modelChanged() {
    for (const r of this.refs) { this.dispose(r.obj); r.tag.remove(); }
    this.refs = [];
    this.clearMeasure();
    this.setHover(null);
    this.topos = new WeakMap();
  }
}
