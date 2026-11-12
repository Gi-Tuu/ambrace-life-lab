export const SPOTS = {
  front: { x: 5.9, z: 2.95 },
  back: { x: 5.9, z: 1.55 },
  bridge: { x: -4.8, z: 0 },
};

const DECK = 0.62;
const HALL = 0.58;
const MOSS = '#568D3E', WOOD = '#BA8752', EDGE = '#72513B';

// x/z are the floor axes. y is height. The same objects draw and block movement.
export const surfaces = [
  { x0: -11, x1: -2.4, z0: -6.5, z1: 6.5, y: 0, color: MOSS, name: '西岸' },
  { x0: 2.4, x1: 11, z0: -6.5, z1: 6.5, y: 0, color: MOSS, name: '东岸' },
  { x0: -4.5, x1: -2.7, z0: -1.15, z1: 1.15, y: 0, end: DECK, axis: 'x', color: WOOD, name: '上桥坡道' },
  { x0: -2.7, x1: 2.7, z0: -1.15, z1: 1.15, y: DECK, color: WOOD, name: '桥面' },
  { x0: 2.7, x1: 4.5, z0: -1.15, z1: 1.15, y: DECK, end: 0, axis: 'x', color: WOOD, name: '下桥坡道' },
  { x0: 5, x1: 10, z0: -2.3, z1: 2.1, y: HALL, color: WOOD, name: '连廊平台' },
  { x0: 6.85, x1: 8.15, z0: 2.1, z1: 3.5, y: HALL, end: 0, axis: 'z', color: WOOD, name: '连廊入口' },
];

export function surfaceHeight(surface, x, z) {
  if (surface.end === undefined) return surface.y;
  const t = surface.axis === 'x' ? (x - surface.x0) / (surface.x1 - surface.x0)
    : (z - surface.z0) / (surface.z1 - surface.z0);
  return surface.y + (surface.end - surface.y) * t;
}

export function surfaceAt(x, z) {
  let floor = null;
  for (const s of surfaces) {
    if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
    const y = surfaceHeight(s, x, z);
    if (!floor || y >= floor.y) floor = { y, name: s.name };
  }
  return floor;
}

export const boxes = [];
export function box(x0, y0, z0, x1, y1, z1, color, solid = false) {
  boxes.push({ x0, y0, z0, x1, y1, z1, color, solid });
}

function railing(x0, z0, x1, z1, floor) {
  box(x0, floor + 0.53, z0, x1, floor + 0.73, z1, WOOD, true);
  box(x0, floor + 0.24, z0, x1, floor + 0.33, z1, EDGE, true);
  const horizontal = x1 - x0 > z1 - z0;
  const length = horizontal ? x1 - x0 : z1 - z0;
  const count = Math.max(1, Math.ceil(length / 1.15));
  for (let i = 0; i <= count; i += 1) {
    const x = horizontal ? x0 + length * i / count : (x0 + x1) / 2;
    const z = horizontal ? (z0 + z1) / 2 : z0 + length * i / count;
    box(x - .06, floor, z - .06, x + .06, floor + .79, z + .06, EDGE, true);
  }
}

railing(5.02, 1.98, 6.74, 2.15, HALL);
railing(8.26, 1.98, 9.98, 2.15, HALL);
railing(5.02, -2.3, 9.98, -2.13, HALL);
railing(5, -2.24, 5.15, 2.04, HALL);
railing(9.85, -2.24, 10, 2.04, HALL);
railing(-2.66, -1.16, 2.66, -1.02, DECK);
railing(-2.66, 1.02, 2.66, 1.16, DECK);

for (const x of [5.25, 9.75]) {
  for (const z of [-2.05, -.82]) box(x-.09, HALL, z-.09, x+.09, 2.66, z+.09, EDGE, true);
}
box(4.85, 2.63, -2.48, 10.15, 2.78, -.56, '#AB5236');
box(4.98, 2.78, -2.32, 10.02, 2.89, -.78, '#AB5236');
box(5.16, 2.89, -2.14, 9.84, 3, -.97, '#7E2553');

export const trees = [[-8.7,-3.7],[-6.5,-4.7],[-8.7,3.8],[9.4,-4.3],[4.2,-4.4]];
for (const [x,z] of trees) box(x-.15,0,z-.14,x+.15,1.17,z+.14,EDGE,true);

const obstacles = boxes.filter(b => b.solid);
export function movePerson(person, dx, dz) {
  const radius = .22;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / .04));
  function tryStep(x, z) {
    const floor = surfaceAt(x, z);
    if (!floor || Math.abs(floor.y - person.y) > .13) return false;
    const blocked = obstacles.some(b => x + radius > b.x0 && x - radius < b.x1 &&
      z + radius > b.z0 && z - radius < b.z1 && floor.y < b.y1 && floor.y + 1.57 > b.y0);
    if (blocked) return false;
    person.x = x; person.z = z; person.y = floor.y; person.floor = floor.name;
    return true;
  }
  let blocked = false;
  for (let i = 0; i < steps; i += 1) {
    if (dx && !tryStep(person.x + dx / steps, person.z)) blocked = true;
    if (dz && !tryStep(person.x, person.z + dz / steps)) blocked = true;
  }
  return blocked;
}

export function atSpot(id) {
  const { x, z } = SPOTS[id];
  const { y, name } = surfaceAt(x, z);
  return { x, y, z, floor: name };
}
