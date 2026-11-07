const close = (a, b, tol, what) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
// a box on the plate: nothing overhangs
const b = box(20, 10, 20).onPlate();
close(overhangs(b).area, 0, 1e-9, 'box overhang'); close(unsupported(b).area, 0, 1e-9, 'box unsupported');
assert(b.printability().ok, 'box ok');
// floating box: its underside is unsupported
const f = box(20, 10, 20).translate(0, 15, 0);
close(overhangs(f).area, 400, 1e-6, 'floating overhang'); close(unsupported(f).area, 400, 1e-6, 'floating unsupported');
// a table: plate on a post. Underside of the plate is an overhang (minus the post), nothing supports it except the post area
const table = box(40, 3, 40).translate(0, 21.5, 0).add(cylinder(5, 20).translate(0, 10, 0));
const over = overhangs(table);
close(over.area, 1600 - Math.PI * 25, 0.01, 'table overhang');
close(unsupported(table).area, 1600 - Math.PI * 25, 0.01, 'table unsupported');
assert(!table.printability().ok, 'table not ok'); echo(table.printability().problems);
// a 45° roof is fine, a 60° one is not (angle from vertical)
const wedge = polyhedron([[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10], [0, 10, 0], [0, 10, 10]], [[0, 1, 2, 3], [4, 5, 2, 1], [0, 4, 1], [3, 2, 5], [0, 3, 5, 4]]);
close(overhangs(wedge).area, 0, 1e-9, 'wedge slope faces up');
const underhang = wedge.rotate(0, 0, 180).onPlate(); // the slope now faces down at 45°
echo('underhang', overhangs(underhang), overhangs(underhang, { angle: 40 }));
close(overhangs(underhang).area, 0, 1e-6, '45° allowed at 45°');
close(overhangs(underhang, { angle: 40 }).area, 10 * 10 * Math.SQRT2, 1e-6, '45° flagged at 40°');
// walls: a shelled cup with 1.2 mm walls
const cup = cylinder(10, 20, { segments: 64 }).onPlate().shell(1.2, { open: 'top' });
const w = minWallThickness(cup);
echo('cup wall', w);
close(w.thickness, 1.2, 0.05, 'cup wall');
assert(cup.printability().ok, 'cup ok');
const thin = box(20, 10, 0.4).onPlate();
assert(!thin.printability({ minWall: 0.8 }).ok, 'thin flagged'); echo(thin.printability().problems);
// solid with no second surface
echo('solid wall', minWallThickness(b).thickness);
return [b.translate(-30, 0, 0), table.translate(40, 0, 0), cup, thin.translate(0, 0, 30)];
