import logo, { markup } from './logo.svg';
const close = (a, b, tol, what) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
const PI = Math.PI;
// 1. an imported file: 40 x 20 mm (viewBox scaled to the mm size), evenodd hole of radius 5 mm, bottom-left at the origin
const b = logo.bounds();
close(b.min[0], 0, 1e-9, 'left'); close(b.min[1], 0, 1e-9, 'bottom'); close(b.size[0], 40, 1e-9, 'width'); close(b.size[1], 20, 1e-9, 'height');
close(logo.area(), 800 - PI * 25, 0.002, 'plate minus the hole (64 segments per turn)');
// the hole is at (20, 10) in Y-up coordinates
assert(logo.intersect(circle(0.5).translate(20, 10)).isEmpty(), 'hole centre is empty');
assert(typeof markup === 'string' && markup.includes('<svg'), 'markup export');
// options: one element by id, fitted to a width
const plate = svg(markup, { width: 80 });
close(plate.bounds().size[0], 80, 1e-9, 'fitted width'); close(plate.area(), 4 * (800 - PI * 25), 0.002, 'fitted area');
// 2. path commands: relative and absolute lines, H/V, cubic, smooth cubic, quadratic, smooth quadratic, arcs
const sq = svgPath('M0 0 h10 v10 H0 Z');
close(sq.area(), 100, 1e-12, 'square'); close(sq.bounds().min[1], -10, 1e-12, 'svgPath flips Y');
// a parabola segment: area under a quadratic from (0,0) via (5,10) to (10,0) is 2/3 × 10 × 5
close(svgPath('M0 0 Q5 10 10 0 Z', { segments: 64 }).area(), (2 / 3) * 50, 0.001, 'quadratic');
// T mirrors the control point: a lobe below the axis the same size (opposite winding, both filled under nonzero)
const wave = svgPath('M0 0 Q5 10 10 0 T20 0 Z', { segments: 64 });
close(wave.area(), (4 / 3) * 50, 0.001, 'smooth quadratic'); close(wave.bounds().min[1], -5, 1e-9, 'upper lobe peaks at 5 (Y flipped)');
// circle by two arcs, packed flags
close(svgPath('M0,0a5 5 0 1010 0a5 5 0 1010 0z').area(), 25 * PI, 0.002, 'circle from arcs with packed flags');
// arcs with rotated ellipses and a too-small radius (scaled up to a half circle)
close(svgPath('M0 0 A1 1 0 0 1 10 0 Z').area(), 12.5 * PI, 0.002, 'radius scaled up to reach');
close(svgPath('M0 0 A10 5 90 0 1 0 20 A10 5 90 0 1 0 0 Z').area(), 50 * PI, 0.002, 'rotated ellipse');
// cubic quarter circle (k = 0.5523) and its smooth continuation into a half circle
const k = 0.5522847498 * 10;
close(svgPath(`M10 0 C10 ${k} ${k} 10 0 10 S-10 ${k} -10 0 Z`, { segments: 64 }).area(), 50 * PI, 0.001, 'cubic + smooth cubic half circle');
// 3. elements, transforms, units, nesting, fill rules
const doc = (body, attrs = 'viewBox="0 0 100 100"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
close(svg(doc('<rect x="10" y="10" width="30" height="20" rx="5"/>')).area(), 600 - (4 - PI) * 25, 0.002, 'rounded rect');
close(svg(doc('<circle cx="50" cy="50" r="10"/><ellipse cx="20" cy="20" rx="10" ry="5"/>')).area(), 150 * PI, 0.002, 'circle + ellipse');
close(svg(doc('<polygon points="0,0 10,0 10,10"/><polyline points="20 0 30 0 30 10"/>')).area(), 100, 1e-9, 'polygon + polyline');
const moved = svg(doc('<g transform="translate(10 20) scale(2)"><rect width="5" height="5" transform="rotate(90 0 0)"/></g>'));
close(moved.area(), 100, 1e-9, 'scaled square'); close(moved.bounds().min[0], 0, 1e-9, 'rotated left'); close(moved.bounds().max[1], 80, 1e-9, 'flipped: top at 100 - 20');
close(svg(doc('<rect width="10" height="10" transform="skewX(45)"/>')).area(), 100, 1e-9, 'skew keeps area');
close(svg(doc('<rect width="10" height="10"/>', 'width="1in" viewBox="0 0 100 100"')).area(), (25.4 / 10) ** 2, 1e-9, 'inches');
close(svg(doc('<rect width="96" height="96"/>', 'width="100px" height="100px"')).area(), 25.4 * 25.4, 1e-9, 'px without a viewBox');
// nonzero: a ring drawn twice the same way fills solid; evenodd makes the inner one a hole
const rings = 'M0 0H20V20H0Z M5 5H15V15H5Z';
close(svg(doc(`<path d="${rings}"/>`)).area(), 400, 1e-9, 'nonzero');
close(svg(doc(`<path fill-rule="evenodd" d="${rings}"/>`)).area(), 300, 1e-9, 'evenodd');
close(svg(doc(`<g style="fill-rule: evenodd"><path d="${rings}"/></g>`)).area(), 300, 1e-9, 'inherited evenodd');
// hidden, unfilled and defs content is left out; id picks one element
const mixed = doc('<rect width="10" height="10"/><rect x="50" width="10" height="10" style="display:none"/><rect id="b" x="20" width="5" height="5" fill="none" stroke="black"/><g id="g"><rect x="70" width="4" height="4"/></g>');
close(svg(mixed).area(), 116, 1e-9, 'the filled, visible rects');
close(svg(mixed, { id: 'g' }).area(), 16, 1e-9, 'id');
// 4. errors explain themselves
for (const [f, re] of [[() => svg('<g/>'), /no <svg> element/], [() => svgPath('M0 0 L5'), /missing a number/], [() => svgPath('M0 0 A1 1 0 2 1 5 5'), /flag must be 0 or 1/],
  [() => svg(doc('<rect/>')), /no filled shapes/], [() => svg(mixed, { id: 'nope' }), /no element with id "nope"/], [() => svgPath('M0 0 L5 5 X'), /unexpected 'X'/],
  [() => svg(doc('<rect width="5" height="5" transform="spin(3)"/>')), /cannot read the transform/]]) {
  let msg = ''; try { f(); } catch (e) { msg = e.message; } assert(re.test(msg), `error: ${msg}`);
}
return extrude(logo, 3);
