/**
 * Files attached to a chat message. Photos, sketches and PDFs are shown to the assistant
 * (image and document blocks); STL, SVG, font and script files are added to the project.
 */
import { ACCEPTED_EXT, IMAGE_EXT } from './project.js';

const SHOWN_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const SHOWN_IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
// The API's guidance: images over ~1568 px on the long edge are scaled down server side anyway (costing
// time and tokens for nothing), and each image must stay under 5 MB.
const MAX_EDGE = 1568;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 30 * 1024 * 1024; // a request may be 32 MB in all

const extOf = (name) => (name.match(/\.[^./]+$/)?.[0] ?? '').toLowerCase();

/** 'image' (shown), 'pdf' (shown), 'file' (added to the project) or { error }. */
export function classify(file) {
  const ext = extOf(file.name);
  if (SHOWN_IMAGE_TYPES.includes(file.type) || SHOWN_IMAGE_EXT.includes(ext)) return 'image';
  if (file.type === 'application/pdf' || ext === '.pdf') return file.size > MAX_PDF_BYTES ? { error: `${file.name} is over 30 MB; the API takes up to 32 MB per message` } : 'pdf';
  if (ACCEPTED_EXT.includes(ext)) return 'file';
  return { error: `${file.name}: attach photos (.png, .jpg, .webp, .gif) or PDFs to show the assistant, or ${ACCEPTED_EXT.join(', ')} files to add to the project` };
}

export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const canvasBlob = (canvas, type, quality) => new Promise((resolve, reject) =>
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image'))), type, quality));

async function draw(file, maxEdge) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); // phone photos carry EXIF rotation
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const source = { width: bmp.width, height: bmp.height };
  bmp.close();
  return { canvas, source };
}

/**
 * An image block for the model: scaled so the long edge is at most 1568 px, PNG for drawings and
 * screenshots (if it stays small), JPEG otherwise. Returns { mediaType, data, width, height, source }.
 */
export async function prepareImage(file) {
  const { canvas, source } = await draw(file, MAX_EDGE);
  let blob = file.type === 'image/png' || extOf(file.name) === '.png' ? await canvasBlob(canvas, 'image/png') : null;
  if (!blob || blob.size > MAX_IMAGE_BYTES * 0.7) blob = await canvasBlob(canvas, 'image/jpeg', 0.88);
  for (let q = 0.75; blob.size > MAX_IMAGE_BYTES * 0.7 && q > 0.3; q -= 0.15) blob = await canvasBlob(canvas, 'image/jpeg', q);
  return { mediaType: blob.type, data: await blobToBase64(blob), width: canvas.width, height: canvas.height, source };
}

/**
 * The image as a project file (heightmap / lithophane take .png and .jpg): the original bytes when it
 * already is one, otherwise converted to PNG at full size. name picks the file name; its extension
 * follows the image's real type. Returns { name, buffer }.
 */
export async function projectImage(file, name) {
  const srcExt = extOf(file.name);
  const stem = (name || file.name).replace(/\.[^./]*$/, '');
  if (IMAGE_EXT.includes(srcExt)) return { name: stem + srcExt, buffer: await file.arrayBuffer() };
  const { canvas } = await draw(file, Infinity);
  return { name: `${stem}.png`, buffer: await (await canvasBlob(canvas, 'image/png')).arrayBuffer() };
}
