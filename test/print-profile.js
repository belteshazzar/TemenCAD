const close = (a, b, tol, what) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
// defaults before any declaration
close(wall(1), 1.2, 1e-9, 'wall default nozzle'); close(layers(3.1), 3.2, 1e-9, 'layers default'); close(fit(5), 5.5, 1e-9, 'fit default');
close(hole(2, 10).bounds().size[0], 4, 1e-6, 'hole uncompensated without a profile');
// declare a profile
const p = printer({ nozzle: 0.6, layer: 0.3, holeCompensation: 0.3, material: 'PETG' });
assert(p.declared && p.material === 'PETG' && printProfile().nozzle === 0.6, 'profile active');
close(wall(1), 1.2, 1e-9, 'wall 0.6 → 2 lines'); close(wall(1.3), 1.8, 1e-9, 'wall rounds up'); close(wall(0, { lines: 3 }), 1.8, 1e-9, 'wall by lines');
close(layers(1), 1.2, 1e-9, 'layers 0.3'); close(layers(0, { count: 4 }), 1.2, 1e-9, 'layers by count'); close(layers(0.9), 0.9, 1e-9, 'exact layers unchanged');
close(fit(5, 'press'), 5.2, 1e-9, 'press'); close(fit(5, 'snug'), 5.3, 1e-9, 'snug'); close(fit(5, 'slide'), 5.45, 1e-9, 'slide'); close(fit(5), 5.6, 1e-9, 'clearance'); close(fit(5, 'loose'), 5.9, 1e-9, 'loose'); close(fit(5, 0.05), 5.35, 1e-9, 'numeric allowance');
close(peg(6, 'slide'), 6 - 0.15 - 0.15, 1e-9, 'peg');
close(hole(2, 10).bounds().size[0], 4.3, 1e-6, 'hole compensated once declared');
close(hole(2, 10, { tolerance: 0 }).bounds().size[0], 4, 1e-6, 'explicit tolerance wins');
let threw = false; try { printer({ nozzel: 0.4 }); } catch { threw = true; } assert(threw, 'typo rejected');
threw = false; try { fit(5, 'tight'); } catch { threw = true; } assert(threw, 'unknown fit rejected');
// a pin and its socket modelled from one nominal
const NOMINAL = 6;
const pin = cylinder(peg(NOMINAL, 'slide') / 2, 12, { center: false });
const block = box(20, 10, 20).onPlate().subtract(cylinder(fit(NOMINAL, 'slide') / 2, 12).translate(0, 5, 0));
assert(fit(NOMINAL, 'slide') - peg(NOMINAL, 'slide') > 0.3, 'socket is larger than the peg');
return [block, pin.translate(30, 0, 0)];
