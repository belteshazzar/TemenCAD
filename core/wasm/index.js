/**
 * JavaScript wrapper around the TemenCAD core WebAssembly module.
 *
 *   import { createRuntime } from './index.js';
 *   const rt = await createRuntime();
 *   const result = rt.run({ 'main.js': 'return box(10)' });
 *   // result: { ok, error, messages: [{ kind, text, file, line }], parts: [{ name, positions, indices, volume, ... }], ms,
 *   //           profile: null | { nozzle, layer, holeCompensation, material, declared } }
 *
 * `files` maps project paths to strings (scripts) or Uint8Array / ArrayBuffer (binary assets).
 * The same shape of result the browser worker produces today, so the app can swap runtimes.
 */
import createTemenCore from './dist/temencore.mjs';

export async function createRuntime(moduleOptions = {}) {
  const M = await createTemenCore(moduleOptions);
  if (!M._tw_init()) throw new Error('TemenCAD core failed to start');
  const str = (ptr) => (ptr ? M.UTF8ToString(ptr) : null);

  const run = (files) => {
    M._tw_clear_files();
    for (const [name, content] of Object.entries(files)) {
      let bytes;
      if (typeof content === 'string') {
        const n = M.lengthBytesUTF8(content);
        const p = M._malloc(n + 1);
        M.stringToUTF8(content, p, n + 1);
        bytes = { ptr: p, len: n };
      } else {
        const u8 = content instanceof Uint8Array ? content : new Uint8Array(content);
        const p = M._malloc(u8.length || 1);
        M.HEAPU8.set(u8, p);
        bytes = { ptr: p, len: u8.length };
      }
      const nameLen = M.lengthBytesUTF8(name) + 1;
      const namePtr = M._malloc(nameLen);
      M.stringToUTF8(name, namePtr, nameLen);
      M._tw_add_file(namePtr, bytes.ptr, bytes.len);
      M._free(namePtr);
    }
    const status = M._tw_run();
    const messages = [];
    for (let i = 0; i < M._tw_msg_count(); i++) {
      messages.push({ kind: M._tw_msg_kind(i) === 1 ? 'warn' : 'log', text: str(M._tw_msg_text(i)), file: str(M._tw_msg_file(i)), line: M._tw_msg_line(i) || null });
    }
    const result = { ok: status === 0, status, error: null, messages, parts: [], ms: M._tw_last_ms(), profile: null, annotations: [] };
    if (status === 0) for (let i = 0; i < M._tw_annotation_count(); i++) result.annotations.push(JSON.parse(str(M._tw_annotation(i))));
    if (status === 0 && M._tw_profile_declared()) {
      result.profile = { nozzle: M._tw_profile_nozzle(), layer: M._tw_profile_layer(), holeCompensation: M._tw_profile_hole_compensation(), material: str(M._tw_profile_material()), declared: true };
    }
    if (status !== 0) {
      result.error = { message: str(M._tw_error()), file: str(M._tw_error_file()), line: M._tw_error_line() || null };
      return result;
    }
    for (let i = 0; i < M._tw_part_count(); i++) {
      const nv = M._tw_part_nverts(i), nt = M._tw_part_ntris(i);
      const pp = M._tw_part_positions(i) >> 2, ip = M._tw_part_indices(i) >> 2;
      result.parts.push({
        name: str(M._tw_part_name(i)),
        named: !!M._tw_part_named(i),
        color: str(M._tw_part_color(i)),
        ghost: !!M._tw_part_ghost(i),
        hidden: !!M._tw_part_hidden(i),
        positions: Float32Array.from(M.HEAPF32.subarray(pp, pp + nv * 3)),
        indices: Uint32Array.from(M.HEAPU32.subarray(ip, ip + nt * 3)),
        volume: M._tw_part_volume(i),
      });
    }
    return result;
  };

  /** Outlines of a string for drawing labels: { rings: [[[x, y], ...]], width }. Throws on an unknown font. */
  const textOutlines = (text, { size = 10, font = 'Inter', align = 'left', letterSpacing = 0, kerning = true, curveSegments = 8 } = {}) => {
    const alloc = (s) => { const n = M.lengthBytesUTF8(s) + 1; const p = M._malloc(n); M.stringToUTF8(s, p, n); return p; };
    const t = alloc(text), f = alloc(font);
    const p = M._tw_text_outlines(t, f, size, align === 'center' ? 1 : align === 'right' ? 2 : 0, letterSpacing, kerning ? 1 : 0, curveSegments);
    M._free(t); M._free(f);
    if (!p) throw new Error(str(M._tw_error()) ?? 'text outlines failed');
    return JSON.parse(str(p));
  };

  /** The part of a closed mesh with coordinate[axis] <= value, cut face filled; null when nothing remains. */
  const cutMesh = (positions, indices, axis, value) => {
    const pp = M._malloc(positions.length * 4), ip = M._malloc(indices.length * 4);
    M.HEAPF32.set(positions, pp >> 2); M.HEAPU32.set(indices, ip >> 2);
    const status = M._tw_cut_mesh(pp, positions.length / 3, ip, indices.length / 3, 'xyz'.indexOf(axis), value);
    M._free(pp); M._free(ip);
    if (status === 1) return null;
    if (status !== 0) throw new Error('mesh could not be cut');
    const nv = M._tw_cut_nverts(), nt = M._tw_cut_ntris();
    const po = M._tw_cut_positions() >> 2, io = M._tw_cut_indices() >> 2;
    return { positions: Float32Array.from(M.HEAPF32.subarray(po, po + nv * 3)), indices: Uint32Array.from(M.HEAPU32.subarray(io, io + nt * 3)) };
  };

  const putBytes = (u8) => { const p = M._malloc(u8.length || 1); M.HEAPU8.set(u8, p); return p; };
  const putString = (s) => { const n = M.lengthBytesUTF8(s) + 1; const p = M._malloc(n); M.stringToUTF8(s, p, n); return p; };
  const bytesAt = (ptr, len) => M.HEAPU8.slice(ptr, ptr + len);

  /**
   * The conversation as archive entries (core/CONVERSATION.md): `json` is the format-2 document as the
   * app holds it (a string or an object), with base64 sources inline and { $blob: key } references to
   * `blobs` (a Map or object of key -> Uint8Array). Returns { '.assistant/conversation.json': bytes,
   * '.assistant/blobs/<sha256>': bytes, ... }. Throws with the core's message.
   */
  const packConversation = (json, blobs = new Map()) => {
    M._tw_conv_clear();
    for (const [key, bytes] of blobs instanceof Map ? blobs : Object.entries(blobs)) {
      const k = putString(key);
      M._tw_conv_add_blob(k, putBytes(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)), bytes.byteLength ?? bytes.length);
      M._free(k);
    }
    const text = new TextEncoder().encode(typeof json === 'string' ? json : JSON.stringify(json));
    const jp = putBytes(text);
    const n = M._tw_conv_pack(jp, text.length);
    M._free(jp);
    if (n < 0) { const e = str(M._tw_conv_error()); M._tw_conv_clear(); throw new Error(e); }
    const out = {};
    for (let i = 0; i < n; i++) out[str(M._tw_conv_file_name(i))] = bytesAt(M._tw_conv_file_data(i), M._tw_conv_file_len(i));
    M._tw_conv_clear();
    return out;
  };

  /**
   * The conversation in a project's archive entries ({ path: Uint8Array }, e.g. its extras), or null
   * when there is none: { json: string, blobs: Map<sha256, Uint8Array> } with base64 sources inline.
   * Throws when it cannot be read (another format, a missing or damaged blob).
   */
  const unpackConversation = (entries) => {
    M._tw_conv_clear();
    for (const [name, bytes] of Object.entries(entries ?? {})) {
      if (!name.startsWith('.assistant/')) continue;
      const k = putString(name);
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      M._tw_conv_add_file(k, putBytes(u8), u8.length);
      M._free(k);
    }
    const status = M._tw_conv_unpack();
    if (status < 0) { const e = str(M._tw_conv_error()); M._tw_conv_clear(); throw new Error(e); }
    if (status === 0) { M._tw_conv_clear(); return null; }
    const json = new TextDecoder().decode(bytesAt(M._tw_conv_json(), M._tw_conv_json_len()));
    const blobs = new Map();
    for (let i = 0; i < M._tw_conv_blob_count(); i++) blobs.set(str(M._tw_conv_blob_key(i)), bytesAt(M._tw_conv_blob_data(i), M._tw_conv_blob_len(i)));
    M._tw_conv_clear();
    return { json, blobs };
  };

  return { run, textOutlines, cutMesh, packConversation, unpackConversation, version: str(M._tw_version()) };
}
