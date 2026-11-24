// Reuse the machine's physical shoe width, track gauge, and link pitch.
const TRACK_OFFSET = 1.09;
const SHOE_WIDTH = 0.68;
const PITCH = (4 * 1.62 + 2 * Math.PI * 0.45) / 48;
const MAX_PRINTS = 1024;
const GRID_STEP = 0.125;

function shoeTexture(T) {
  const width = 64,
    height = 128;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = ((x + 0.5) / width) * 2 - 1;
      const v = ((y + 0.5) / height) * 2 - 1;
      const margin = Math.min((1 - Math.abs(u)) * 9, (1 - Math.abs(v)) * 16);
      const shoe = Math.min(1, margin);
      const grouser = Math.abs(u + 0.35 - 0.065 * v) < 0.14 && Math.abs(v) < 0.93;
      const second = Math.abs(u - 0.42 + 0.06 * v) < 0.09 && Math.abs(v) < 0.88;
      const grit = ((Math.imul(x + 3, 73856093) ^ Math.imul(y + 3, 19349663)) >>> 0) % 12;
      const ink = shoe * (0.062 + (grouser ? 0.21 : 0) + (second ? 0.135 : 0) + grit / 1100);
      const gray = Math.round(255 * (1 - ink));
      const i = (y * width + x) * 4;
      data[i] = gray;
      data[i + 1] = gray;
      data[i + 2] = gray;
      data[i + 3] = 255;
    }
  }
  const texture = new T.DataTexture(data, width, height);
  texture.colorSpace = T.SRGBColorSpace;
  texture.magFilter = T.LinearFilter;
  texture.minFilter = T.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// world_ground returns the nearest cell's surface. Match the terrain renderer's
// interpolated triangles when setting the ends of a grouser on a bank.
function renderedHeight(ground, x, z) {
  const px = x / GRID_STEP - 0.5,
    pz = z / GRID_STEP - 0.5;
  const ix = Math.floor(px),
    iz = Math.floor(pz),
    u = px - ix,
    v = pz - iz;
  const ax = (ix + 0.5) * GRID_STEP,
    az = (iz + 0.5) * GRID_STEP;
  const bx = ax + GRID_STEP,
    bz = az + GRID_STEP;
  if (u + v <= 1) return ground(ax, az) * (1 - u - v) + ground(bx, az) * u + ground(ax, bz) * v;
  return ground(bx, bz) * (u + v - 1) + ground(ax, bz) * (1 - u) + ground(bx, az) * (1 - v);
}

export function createTreads(T, scene) {
  const geometry = new T.PlaneGeometry(0.183, SHOE_WIDTH);
  geometry.rotateX(-Math.PI * 0.5);
  const material = new T.MeshBasicMaterial({
    map: shoeTexture(T),
    blending: T.MultiplyBlending,
    premultipliedAlpha: true,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    toneMapped: false,
    fog: false,
  });
  const prints = new T.InstancedMesh(geometry, material, MAX_PRINTS);
  prints.name = 'Crawler shoe impressions';
  prints.count = 0;
  prints.instanceMatrix.setUsage(T.DynamicDrawUsage);
  prints.frustumCulled = false;
  scene.add(prints);

  let seeded = false,
    lastX = 0,
    lastZ = 0,
    lastYaw = 0,
    head = 0;
  const remainder = [0, 0];
  const matrix = new T.Matrix4();
  const erased = new T.Matrix4().makeScale(0, 0, 0);
  const raised = new Map();
  const locations = new Map();
  const keys = new Array(MAX_PRINTS);

  function erase(slot) {
    const key = keys[slot];
    if (locations.get(key) === slot) locations.delete(key);
    raised.delete(slot);
    keys[slot] = undefined;
  }
  function upload(start, count) {
    prints.instanceMatrix.addUpdateRange(start * 16, count * 16);
    prints.instanceMatrix.needsUpdate = true;
  }
  function stamp(x, z, yaw, ground) {
    // Crossing tracks can overlap. A reverse pass along the same pads should
    // have one imprint, so avoid repeatedly multiplying identical marks.
    const key =
      ((Math.round(x / 0.105) + 512) * 1024 + Math.round(z / 0.105) + 512) * 16 +
      (((Math.round((yaw / Math.PI) * 16) % 16) + 16) % 16);
    if (locations.has(key)) return;
    const cs = Math.cos(yaw),
      sn = Math.sin(yaw),
      hw = SHOE_WIDTH * 0.5,
      hl = 0.183 * 0.5;
    const mid = renderedHeight(ground, x, z);
    const front = renderedHeight(ground, x + hl * cs, z - hl * sn);
    const rear = renderedHeight(ground, x - hl * cs, z + hl * sn);
    const outer = renderedHeight(ground, x + hw * sn, z + hw * cs);
    const inner = renderedHeight(ground, x - hw * sn, z - hw * cs);
    // A shoe can't imprint across a sharp ledge. Leave that contact gap open.
    if (
      Math.abs((outer + inner) * 0.5 - mid) > 0.018 ||
      Math.abs((front + rear) * 0.5 - mid) > 0.015
    )
      return;
    const slot = head;
    erase(slot);
    const longSlope = (front - rear) / 0.183,
      shortSlope = (outer - inner) / SHOE_WIDTH;
    matrix.set(cs, 0, sn, x, longSlope, 1, shortSlope, mid + 0.001, -sn, 0, cs, z, 0, 0, 0, 1);
    prints.setMatrixAt(slot, matrix);
    prints.count = Math.max(prints.count, slot + 1);
    locations.set(key, slot);
    keys[slot] = key;
    if (mid > 0.004 || Math.abs(shortSlope) > 0.03 || Math.abs(longSlope) > 0.03) {
      raised.set(slot, { x, z, y: mid, edgeX: x + hw * sn, edgeZ: z + hw * cs, edgeY: outer });
    }
    upload(slot, 1);
    head = (head + 1) % MAX_PRINTS;
  }
  function update(x, z, yaw, ground) {
    if (!seeded) {
      lastX = x;
      lastZ = z;
      lastYaw = yaw;
      seeded = true;
      return;
    }
    if (x === lastX && z === lastZ && yaw === lastYaw) return;
    const dx = x - lastX,
      dz = z - lastZ;
    const dyaw = Math.atan2(Math.sin(yaw - lastYaw), Math.cos(yaw - lastYaw));
    // A reset or teleport should never leave a line across the pit.
    if (Math.hypot(dx, dz) > 2 || Math.abs(dyaw) > 0.72) {
      remainder.fill(0);
    } else {
      for (let side = 0; side < 2; side++) {
        const offset = side ? TRACK_OFFSET : -TRACK_OFFSET;
        const sx = lastX + offset * Math.sin(lastYaw),
          sz = lastZ + offset * Math.cos(lastYaw);
        const ex = x + offset * Math.sin(yaw),
          ez = z + offset * Math.cos(yaw);
        const distance = Math.hypot(ex - sx, ez - sz);
        for (let d = PITCH - remainder[side]; d <= distance; d += PITCH) {
          const t = d / distance;
          const a = lastYaw + dyaw * t;
          stamp(
            lastX + dx * t + offset * Math.sin(a),
            lastZ + dz * t + offset * Math.cos(a),
            a,
            ground,
          );
        }
        remainder[side] = (remainder[side] + distance) % PITCH;
      }
    }
    lastX = x;
    lastZ = z;
    lastYaw = yaw;
  }
  function refresh(ground) {
    // The empty bed cannot sink below zero. Only elevated prints can become
    // unsupported when a later cut or avalanche changes the terrain.
    for (const [slot, r] of raised) {
      if (
        Math.abs(renderedHeight(ground, r.x, r.z) - r.y) <= 0.007 &&
        Math.abs(renderedHeight(ground, r.edgeX, r.edgeZ) - r.edgeY) <= 0.007
      )
        continue;
      prints.setMatrixAt(slot, erased);
      erase(slot);
      upload(slot, 1);
    }
  }
  function reset() {
    seeded = false;
    head = 0;
    prints.count = 0;
    remainder.fill(0);
    locations.clear();
    raised.clear();
    keys.fill(undefined);
    prints.instanceMatrix.clearUpdateRanges();
  }
  return { update, refresh, reset };
}
