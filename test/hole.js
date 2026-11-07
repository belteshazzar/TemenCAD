const close = (a, b, tol, what) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a.toFixed(3)} vs ${b.toFixed(3)}`);
// teardrop: circle plus the 45° point; the point lies at y = r*sqrt(2)
const td = teardrop(4);
const b = td.bounds();
close(b.max[1], 4 * Math.SQRT2, 1e-6, 'apex'); close(b.min[1], -4, 1e-6, 'bottom'); close(b.max[0], 4, 1e-3, 'width');
close(td.area(), Math.PI * 16 * (1 - 0.25) + 16, 0.01, 'teardrop area'); // 3/4 circle + the square between the tangents
close(teardrop(4, { flat: 5 }).bounds().max[1], 5, 1e-6, 'flat');
assert(teardrop(4, { flat: 5 }).area() < td.area(), 'flat area smaller');
close(bridgedCircle(4).bounds().max[1], 4, 1e-3, 'bridge top');
assert(bridgedCircle(4).area() > Math.PI * 16 && bridgedCircle(4).area() < td.area(), 'bridge area');
// hole(): orientation and point up
const hz = hole(3, 20, { axis: 'z' }), hx = hole(3, 20, { axis: 'x' }), hy = hole(3, 20, { axis: 'y' });
echo('z', hz.bounds().size, 'x', hx.bounds().size, 'y', hy.bounds().size);
close(hz.bounds().size[2], 20, 1e-6, 'z length'); close(hz.bounds().max[1], 3 * Math.SQRT2, 1e-6, 'z point up');
close(hx.bounds().size[0], 20, 1e-6, 'x length'); close(hx.bounds().max[1], 3 * Math.SQRT2, 1e-6, 'x point up');
close(hy.bounds().size[1], 20, 1e-6, 'y length'); close(hy.bounds().size[0], 6, 1e-3, 'y round');
close(hole(3, 20, { axis: 'z', shape: 'bridge' }).bounds().max[1], 3, 1e-3, 'bridge z');
close(hole(3, 20, { axis: 'x', tolerance: 0.4 }).bounds().size[2], 6.4, 1e-3, 'tolerance');
// screwHole bridge leaves a membrane: subtracting from a block keeps a 0.2 mm disc
const blk = box(20, 10, 20).onPlate();
const plain = blk.subtract(screwHole('M4', 10, { type: 'counterbore' }).translate(0, 10, 0));
const bridged = blk.subtract(screwHole('M4', 10, { type: 'counterbore', bridge: 0.2 }).translate(0, 10, 0));
const d = bridged.volume() - plain.volume();
close(d, Math.PI * ((4.5 + 0.2) / 2) ** 2 * 0.2, 0.03, 'membrane volume');
const csk = blk.subtract(screwHole('M3', 10, { type: 'countersunk', bridge: 0.2 }).translate(0, 10, 0));
assert(csk.volume() > blk.subtract(screwHole('M3', 10, { type: 'countersunk' }).translate(0, 10, 0)).volume(), 'csk bridge');
const bar = box(30, 12, 10).onPlate();
return [bar.subtract(hole(3, 12).translate(-9, 6, 0)).subtract(hole(3, 12, { shape: 'bridge' }).translate(0, 6, 0)).subtract(hole(3, 12, { shape: 'round' }).translate(9, 6, 0)), bridged.translate(40, 0, 0), plain.translate(-40, 0, 0)];
