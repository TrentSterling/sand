import { WEIGH_BAY } from './quarry.js';

// Read the same cell-centred triangles the terrain renderer uploads. The
// collider needs height and gradient together for each rigid shoe contact.
export function driveGround(core, world) {
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
    const dx = (h(x - 0.13, z) - h(x + 0.13, z)) / 0.26,
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
export function yardClearance(x, y, z, n) {
  // Low perimeter stops constrain the crawlers while leaving the elevated
  // attachment free to overhang the edge of the playable yard.
  let best = Math.max(y - 0.65, 15.55 - Math.max(Math.abs(x), Math.abs(z)));
  if (best === y - 0.65) n.set(0, 1, 0);
  else if (Math.abs(x) > Math.abs(z)) n.set(-Math.sign(x), 0, 0);
  else n.set(0, 0, -Math.sign(z));
  for (const [left, right, near, far] of walls) {
    const dx = Math.max(left - x, x - right),
      dz = Math.max(near - z, z - far),
      dy = y - bay.height;
    const distance = Math.max(dx, dy, dz);
    if (distance >= best) continue;
    best = distance;
    if (distance === dy) n.set(0, 1, 0);
    else if (distance === dx) n.set(x < (left + right) / 2 ? -1 : 1, 0, 0);
    else n.set(0, 0, z < (near + far) / 2 ? -1 : 1);
  }
  return best;
}
