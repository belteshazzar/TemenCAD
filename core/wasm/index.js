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

  return { run, version: str(M._tw_version()) };
}
