import { escapeYard, onDeck, deckTop } from './escape.js';
import { WEIGH_BAY } from './quarry.js';
import { fleet } from './trucks.js';

// Read the same cell-centred triangles the terrain renderer uploads. The
// collider needs height and gradient together for each rigid shoe contact.
export function driveGround(core, world, escape = false) {
  let memory, sand, pack;
  function sync() {
    if (memory === core.memory.buffer) return;
    memory = core.memory.buffer;
    sand = new Int32Array(memory, core.world_height(world), 256 * 256);
    pack = new Uint8Array(memory, core.world_compact(world), 256 * 256);
  }
  function depth(i) {
    return (sand[i] - ((sand[i] * pack[i]) >> 11)) * 0.001;
  }
  function h(x, z) {
    const a = Math.max(0, Math.min(254.999, (x + 16) * 8 - 0.5)),
      b = Math.max(0, Math.min(254.999, (z + 16) * 8 - 0.5));
    const i = (a | 0) + (b | 0) * 256,
      u = a - (a | 0),
      v = b - (b | 0);
    if (u + v <= 1) return (1 - u - v) * depth(i) + u * depth(i + 1) + v * depth(i + 256);
    return (u + v - 1) * depth(i + 257) + (1 - u) * depth(i + 256) + (1 - v) * depth(i + 1);
  }
  return (x, z, out) => {
    sync();
    out.height = out.soil = h(x, z);
    const sandOnDeck = escape && out.soil > 0 && onDeck(x, z);
    if (sandOnDeck) out.height += deckTop(x);
    out.packing =
      pack[
        Math.max(0, Math.min(255, Math.floor((z + 16) * 8))) * 256 +
          Math.max(0, Math.min(255, Math.floor((x + 16) * 8)))
      ] / 255;
    if (out.height <= 0) {
      out.nx = out.nz = 0;
      out.ny = 1;
      return;
    }
    const bevelSlope =
      sandOnDeck && x < escapeYard.lip + escapeYard.bevelRun
        ? escapeYard.bevelRise / escapeYard.bevelRun
        : 0;
    const dx = (h(x - 0.13, z) - h(x + 0.13, z)) / 0.26 - bevelSlope,
      dz = (h(x, z - 0.13) - h(x, z + 0.13)) / 0.26;
    const inv = 1 / Math.hypot(dx, 1, dz);
    out.nx = dx * inv;
    out.ny = inv;
    out.nz = dz * inv;
  };
}

const bay = WEIGH_BAY;
const walls = [
  [bay.left - bay.wall, bay.left, bay.mouth, bay.back + bay.wall],
  [bay.right, bay.right + bay.wall, bay.mouth, bay.back + bay.wall],
  [bay.left, bay.right, bay.back, bay.back + bay.wall],
];
const escapeWalls = [
  ...walls,
  [
    escapeYard.lip,
    escapeYard.roadEnd,
    -escapeYard.halfWidth,
    escapeYard.halfWidth,
    escapeYard.height,
    true,
  ],
];
const haulWalls = [...walls];
const truckSegments = [];
for (const t of fleet) {
  const start = haulWalls.length;
  const l = t.length / 2,
    w = t.width / 2,
    floor = t.floor;
  haulWalls.push([t.x - l, t.x + l, t.z - w, t.z + w, floor]);
  for (const s of [-1, 1]) {
    haulWalls.push([
      t.x - l - 0.06,
      t.x + l + 0.06,
      t.z + s * w - 0.09,
      t.z + s * w + 0.09,
      floor + 0.75,
    ]);
    haulWalls.push([t.x + s * l - 0.09, t.x + s * l + 0.09, t.z - w, t.z + w, floor + 0.75]);
  }
  const cab = t.x + t.heading * (l + (t === fleet[1] ? 1.36 : 0.85));
  haulWalls.push([cab - 0.59, cab + 0.59, t.z - 0.78, t.z + 0.78, 2.35]);
  const hood = cab + t.heading * 1.15;
  haulWalls.push([hood - 0.65, hood + 0.65, t.z - 0.78, t.z + 0.78, 1.65]);
  truckSegments.push(
    haulWalls.slice(start).map((wall) => ({ wall, left: wall[0], right: wall[1] })),
  );
}
export function positionTruckWalls(core, w) {
  truckSegments.forEach((segments, i) => {
    const dx = core.world_truck_offset(w, i);
    for (const segment of segments) {
      segment.wall[0] = segment.left + dx;
      segment.wall[1] = segment.right + dx;
    }
  });
}
export const haulClearance = (x, y, z, n) => yardClearance(x, y, z, n, haulWalls);
export function yardClearance(x, y, z, n, obstacles = walls) {
  // Low perimeter stops constrain the crawlers while leaving the elevated
  // attachment free to overhang the edge of the playable yard.
  const serviceRoad =
    obstacles === escapeWalls && x > escapeYard.lip && Math.abs(z) <= escapeYard.halfWidth;
  const edge = serviceRoad
    ? Math.min(escapeYard.roadEnd - x, 15.55 - Math.abs(z))
    : 15.55 - Math.max(Math.abs(x), Math.abs(z));
  const top = serviceRoad ? escapeYard.height + 0.55 : 0.65;
  let best = Math.max(y - top, edge);
  if (best === y - top) n.set(0, 1, 0);
  else if (Math.abs(x) > Math.abs(z)) n.set(-Math.sign(x), 0, 0);
  else n.set(0, 0, -Math.sign(z));
  for (const [left, right, near, far, top = bay.height, bevel = false] of obstacles) {
    const dx = Math.max(left - x, x - right),
      dz = Math.max(near - z, z - far),
      dy = y - top;
    const slope = escapeYard.bevelRise / escapeYard.bevelRun;
    const bevelDistance = bevel
      ? (dy + escapeYard.bevelRise - (x - left) * slope) / Math.hypot(1, slope)
      : -Infinity;
    const distance = Math.max(dx, dy, dz, bevelDistance);
    if (distance >= best) continue;
    best = distance;
    if (distance === bevelDistance) n.set(-slope, 1, 0).normalize();
    else if (distance === dy) n.set(0, 1, 0);
    else if (distance === dx) n.set(x < (left + right) / 2 ? -1 : 1, 0, 0);
    else n.set(0, 0, z < (near + far) / 2 ? -1 : 1);
  }
  return best;
}

export const escapeClearance = (x, y, z, n) => yardClearance(x, y, z, n, escapeWalls);
