// Static quarry scenery is assembled once, then drawn in a few material batches.
// Coordinates are metres, with the open end of the weigh bay facing -Z.
export const WEIGH_BAY = {
  left: -1.8,
  right: 1.8,
  mouth: 3.8,
  back: 7.4,
  wall: 0.24,
  height: 0.78,
};

function randomStream(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function makeGrain(T, rendererScale = 1) {
  const random = randomStream(48);
  const size = 128;
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    const speck = random() < 0.075 ? 40 : 0;
    const value = 248 - rendererScale * (random() * 24 + speck);
    pixels[i] = pixels[i + 1] = pixels[i + 2] = Math.round(value);
    pixels[i + 3] = 255;
  }
  const tex = new T.DataTexture(pixels, size, size);
  tex.wrapS = tex.wrapT = T.RepeatWrapping;
  tex.magFilter = T.LinearFilter;
  tex.minFilter = T.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function batch(T, group, name, material, shadows) {
  const positions = [],
    normals = [],
    colors = [],
    uvs = [];
  const p = new T.Vector3(),
    n = new T.Vector3(),
    nm = new T.Matrix3();
  const c = new T.Color();
  function vertex(x, y, z, nx, ny, nz) {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    colors.push(c.r, c.g, c.b);
    if (Math.abs(ny) > 0.65) uvs.push(x * 1.3, z * 1.3);
    else if (Math.abs(nx) > Math.abs(nz)) uvs.push(z * 1.3, y * 1.3);
    else uvs.push(x * 1.3, y * 1.3);
  }
  function put(geo, matrix, color) {
    const pos = geo.attributes.position,
      norm = geo.attributes.normal;
    const indices = geo.index;
    const count = indices ? indices.count : pos.count;
    c.set(color);
    nm.getNormalMatrix(matrix);
    for (let k = 0; k < count; k++) {
      const i = indices ? indices.getX(k) : k;
      p.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      n.fromBufferAttribute(norm, i).applyNormalMatrix(nm);
      vertex(p.x, p.y, p.z, n.x, n.y, n.z);
    }
  }
  function triangle(a, b, d, color) {
    const ab = new T.Vector3().subVectors(b, a);
    const ad = new T.Vector3().subVectors(d, a);
    n.crossVectors(ab, ad).normalize();
    c.set(color);
    for (const pt of [a, b, d]) vertex(pt.x, pt.y, pt.z, n.x, n.y, n.z);
  }
  function finish() {
    if (!positions.length) return;
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new T.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
    geo.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
    geo.computeBoundingSphere();
    const mesh = new T.Mesh(geo, material);
    mesh.name = name;
    mesh.receiveShadow = true;
    mesh.castShadow = shadows;
    group.add(mesh);
  }
  return { put, triangle, finish };
}

export function createQuarry(T, scene) {
  const site = new T.Group();
  site.name = 'Quarry works';
  scene.add(site);
  const vec = (x, y, z) => new T.Vector3(x, y, z);
  const up = vec(0, 1, 0);
  const random = randomStream(31984);
  const grain = makeGrain(T);
  const rock = batch(
    T,
    site,
    'Quarry terraces',
    new T.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      map: grain,
    }),
    false,
  );
  const civil = batch(
    T,
    site,
    'Weigh bin and yard fittings',
    new T.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.91,
      map: grain,
    }),
    true,
  );
  const metal = batch(
    T,
    site,
    'Aggregate plant',
    new T.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.66,
      metalness: 0.16,
    }),
    true,
  );
  const groundCover = batch(
    T,
    site,
    'Quarry vegetation',
    new T.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
    }),
    false,
  );
  const unitBox = new T.BoxGeometry(1, 1, 1);
  const cylinder8 = new T.CylinderGeometry(1, 1, 1, 8);
  const cylinder24 = new T.CylinderGeometry(1, 1, 1, 24);
  const stoneShape = new T.IcosahedronGeometry(1, 0);
  const mat = new T.Matrix4(),
    quat = new T.Quaternion();
  const scale = new T.Vector3();
  function shape(batch, geo, center, dimensions, color, rotation = null) {
    mat.compose(center, rotation ?? quat.identity(), dimensions);
    batch.put(geo, mat, color);
  }
  function box(batch, x, y, z, sx, sy, sz, color, yaw = 0) {
    quat.setFromAxisAngle(up, yaw);
    mat.compose(vec(x, y, z), quat, scale.set(sx, sy, sz));
    batch.put(unitBox, mat, color);
  }
  function cylinder(batch, x, y, z, radius, height, color, round = false) {
    shape(batch, round ? cylinder24 : cylinder8, vec(x, y, z), vec(radius, height, radius), color);
  }
  function beam(batch, a, b, width, depth, color, tube = false) {
    const direction = new T.Vector3().subVectors(b, a);
    const length = direction.length();
    quat.setFromUnitVectors(up, direction.normalize());
    mat.compose(new T.Vector3().lerpVectors(a, b, 0.5), quat, scale.set(width, length, depth));
    batch.put(tube ? cylinder8 : unitBox, mat, color);
  }
  function cone(batch, x, y, z, top, bottom, height, color, sides = 24) {
    const geo = new T.CylinderGeometry(top, bottom, height, sides, 1);
    shape(batch, geo, vec(x, y, z), vec(1, 1, 1), color);
    geo.dispose();
  }
  function quad(batch, a, b, c, d, tint) {
    batch.triangle(a, b, c, tint);
    batch.triangle(a, c, d, tint);
  }
  function tint(hex, factor) {
    return new T.Color(hex).multiplyScalar(factor);
  }

  // Each terrace shares both contours with the adjoining strata. The broad
  // eastern notch is the access ramp cut through the benches.
  const cuts = [
    [0, 0],
    [0.65, 1.2],
    [0.8, 1.38],
    [1.2, 2.35],
    [3.5, 2.4],
    [4.35, 3.6],
    [4.6, 3.83],
    [5.5, 5],
    [8.9, 5.07],
    [10.0, 7.15],
    [10.5, 7.45],
    [11.6, 8.9],
    [16.0, 9.05],
    [17, 10.8],
    [17.75, 11.4],
    [19.8, 12.9],
    [28, 12.6],
  ];
  const strata = [
    0xb49673, 0x946f55, 0xc5a47d, 0xbda783, 0xc5a486, 0x9e775a, 0xbb997c, 0xcab18f, 0xae8b6b,
    0x8f705b, 0xbca28c, 0xc6b190, 0xb39378, 0x9f806d, 0xb59983, 0xbba98d,
  ];
  const segments = 104;
  const profile = Array.from({ length: segments }, (_, i) => {
    const a = (Math.PI * 2 * i) / segments;
    const r = 28 + 3.9 * Math.sin(a * 3 + 1) + 2.3 * Math.cos(a * 5) + 0.65 * Math.sin(a * 13);
    const cut = Math.max(0, Math.cos(a - 0.1)) ** 14;
    const rise = (1 - 0.78 * cut) * (0.85 + 0.2 * Math.sin(a * 2 - 0.8) + 0.1 * Math.cos(a * 6));
    return cuts.map(([out, y], level) => {
      const radius = r + out + 0.32 * Math.sin(a * 11 + level * 0.29);
      return vec(Math.cos(a) * radius * 1.04, y * rise - 0.25, Math.sin(a) * radius);
    });
  });
  for (let i = 0; i < segments; i++) {
    const first = profile[i],
      next = profile[(i + 1) % segments];
    for (let j = 0; j < cuts.length - 1; j++) {
      const factor = 0.97 + random() * 0.055;
      quad(rock, first[j], next[j], next[j + 1], first[j + 1], tint(strata[j], factor));
    }
  }

  // Fractures and exposed seams follow the triangulated bench faces.
  // Barycentric interpolation keeps their paths attached across the diagonal.
  function facePoint(first, next, j, u, v) {
    const p =
      u > v
        ? first[j]
            .clone()
            .multiplyScalar(1 - u)
            .addScaledVector(next[j], u - v)
            .addScaledVector(next[j + 1], v)
        : first[j]
            .clone()
            .multiplyScalar(1 - v)
            .addScaledVector(next[j + 1], u)
            .addScaledVector(first[j + 1], v - u);
    const radial = Math.hypot(p.x, p.z);
    p.x -= (0.042 * p.x) / radial;
    p.z -= (0.042 * p.z) / radial;
    return p;
  }
  for (let i = 0; i < segments; i++) {
    const first = profile[i],
      next = profile[(i + 1) % segments];
    for (const level of [0, 2, 4, 6, 8, 10, 12, 14]) {
      if (random() < 0.57) {
        const u = 0.12 + random() * 0.65,
          lean = (random() - 0.5) * 0.15;
        const top = 0.52 + random() * 0.4,
          bottom = 0.03 + random() * 0.18,
          thickness = 0.012 + random() * 0.035;
        quad(
          rock,
          facePoint(first, next, level, u, bottom),
          facePoint(first, next, level, u + thickness * 0.4, bottom),
          facePoint(first, next, level, u + lean + thickness, top),
          facePoint(first, next, level, u + lean, top),
          tint(strata[level], 0.7 + random() * 0.17),
        );
      }
      if (random() < 0.7) {
        const lower = 0.18 + random() * 0.53,
          end = Math.min(0.98, lower + (random() - 0.5) * 0.22);
        const start = 0.02 + random() * 0.24,
          width = 0.3 + random() * 0.4;
        quad(
          rock,
          facePoint(first, next, level, start, lower),
          facePoint(first, next, level, start + width, end),
          facePoint(first, next, level, start + width * 0.93, end + 0.015),
          facePoint(first, next, level, start + 0.025, lower + 0.035),
          tint(strata[level], 0.8 + random() * 0.31),
        );
      }
    }
  }

  // Rockfall at the toe, with clumps of scrub growing along the undisturbed rim.
  for (let i = 0; i < 230; i++) {
    const s = Math.floor(random() * segments);
    const toe = profile[s][0];
    const w = 0.12 + random() ** 3 * 0.85;
    shape(
      rock,
      stoneShape,
      vec(toe.x * (0.9 + random() * 0.1), w * 0.21, toe.z * (0.9 + random() * 0.1)),
      vec(w * (1 + random()), w * 0.74, w),
      tint(0xaa9375, 0.83 + random() * 0.28),
    );
  }
  for (let i = 0; i < 138; i++) {
    const s = Math.floor(random() * segments);
    const tier = random() < 0.68 ? 15 : 11;
    const base = profile[s][tier].clone().lerp(profile[s][tier + 1], 0.65);
    const r = 0.25 + random() * 0.68;
    const c = [0x787c59, 0x687657, 0x89845e, 0x767350][Math.floor(random() * 4)];
    for (let k = 0; k < 3; k++) {
      shape(
        groundCover,
        stoneShape,
        vec(base.x + (random() - 0.5) * r, base.y + 0.06 + r * 0.4, base.z + (random() - 0.5) * r),
        vec(r * 0.74, r * (0.42 + random() * 0.47), r),
        tint(c, 0.84 + random() * 0.3),
      );
    }
  }

  // The weigh bay has an open floor: deposited material is always the live grid.
  const { left, right, mouth, back, wall, height } = WEIGH_BAY;
  const wallLength = back + wall - mouth;
  const concrete = 0xbdb5a4,
    topStone = 0xd1c9b7,
    joints = 0x807d73;
  const orange = 0xe8a945,
    dark = 0x343b39,
    oxidized = 0x775b45;
  const bayY = height / 2;
  for (const sign of [-1, 1]) {
    const x = sign * (right + wall / 2);
    box(civil, x, bayY, mouth + wallLength / 2, wall, height, wallLength, concrete);
    for (const join of [mouth + 1.3, mouth + 2.6]) {
      box(civil, x, height * 0.49, join, wall + 0.003, height * 0.94, 0.012, joints);
    }
    // Anchor ties along both faces and the nosing markers at the open mouth.
    for (const z of [
      mouth + 0.3,
      mouth + 1.12,
      mouth + 1.58,
      mouth + 2.37,
      mouth + 2.92,
      mouth + 3.52,
    ]) {
      for (const y of [0.21, 0.55]) {
        const a = vec(x - wall / 2 - 0.002, y, z),
          b = vec(x + wall / 2 + 0.002, y, z);
        beam(civil, a, b, 0.018, 0.018, joints, true);
      }
    }
    box(civil, x, height + 0.009, mouth + 0.27, wall - 0.012, 0.018, 0.52, orange);
    for (let k = 0; k < 3; k++)
      box(civil, x, height + 0.019, mouth + 0.12 + k * 0.15, wall - 0.025, 0.003, 0.055, dark);
    box(civil, x, 0.405, mouth - 0.008, wall - 0.012, 0.7, 0.016, orange);
    for (const y of [0.2, 0.48]) box(civil, x, y, mouth - 0.019, wall - 0.022, 0.1, 0.008, dark);
    for (const z of [mouth + 0.95, back - 0.48]) {
      box(civil, x + sign * 0.145, 0.21, z, 0.095, 0.42, 0.3, topStone);
    }
  }
  box(civil, 0, bayY, back + wall / 2, right - left, height, wall, concrete);
  for (const x of [-1.25, -0.63, 0.63, 1.25]) {
    for (const y of [0.2, 0.55])
      beam(
        civil,
        vec(x, y, back - 0.002),
        vec(x, y, back + wall + 0.002),
        0.017,
        0.017,
        joints,
        true,
      );
  }
  makeSign(T, site, 'WEIGH  BAY', '01', vec(0.0, 0.46, back + wall + 0.013), 0, 0.98, 0.48);
  makeSign(T, site, 'WEIGH  BAY', '01', vec(0, 0.46, back - 0.013), Math.PI, 0.98, 0.48);

  // Feed hopper, rising belt, screen head and finished-aggregate silo.
  const green = 0x4c6864,
    greenLight = 0x66807a,
    steel = 0x68746d;
  const zinc = 0xb6b7a4,
    belt = 0x343a37,
    red = 0xae623a,
    cream = 0xd2c5a9;
  const siloX = -13.0,
    siloZ = -9.65;
  const stand = 3.25,
    diameter = 1.37;
  box(civil, siloX, 0.11, siloZ, 3.4, 0.24, 3.4, concrete);
  for (const dx of [-1.1, 1.1])
    for (const dz of [-1.1, 1.1]) {
      box(metal, siloX + dx, stand / 2, siloZ + dz, 0.13, stand, 0.13, green);
      box(metal, siloX + dx, 0.22, siloZ + dz, 0.36, 0.08, 0.36, steel);
    }
  for (const side of [-1, 1]) {
    beam(
      metal,
      vec(siloX - 1.1, 0.42, siloZ + side * 1.1),
      vec(siloX + 1.1, stand - 0.2, siloZ + side * 1.1),
      0.07,
      0.07,
      greenLight,
    );
    beam(
      metal,
      vec(siloX + side * 1.1, 0.42, siloZ - 1.1),
      vec(siloX + side * 1.1, stand - 0.2, siloZ + 1.1),
      0.07,
      0.07,
      greenLight,
    );
  }
  cylinder(metal, siloX, 4.62, siloZ, diameter, 2.73, cream, true);
  cone(metal, siloX, 2.64, siloZ, diameter, 0.3, 1.27, cream);
  cone(metal, siloX, 6.15, siloZ, 0.2, diameter, 0.36, zinc);
  cylinder(metal, siloX, 1.91, siloZ, 0.31, 0.31, red, true);
  for (const y of [3.27, 3.72, 4.59, 5.44, 5.98])
    cylinder(metal, siloX, y, siloZ, diameter + 0.025, 0.043, zinc, true);
  cylinder(metal, siloX, 5.1, siloZ, diameter + 0.009, 0.33, red, true);
  cylinder(metal, siloX, 6.4, siloZ, 0.19, 0.26, steel, true);
  cone(metal, siloX, 6.57, siloZ, 0.045, 0.32, 0.1, green, 16);
  cylinder(metal, siloX + 0.5, 6.13, siloZ + 0.48, 0.23, 0.1, green, true);
  for (const x of [siloX - 0.21, siloX + 0.21]) {
    beam(metal, vec(x, 0.25, siloZ + 1.51), vec(x, 6.3, siloZ + 1.51), 0.027, 0.027, zinc, true);
  }
  for (let y = 0.44; y < 6.3; y += 0.31) {
    beam(
      metal,
      vec(siloX - 0.22, y, siloZ + 1.51),
      vec(siloX + 0.22, y, siloZ + 1.51),
      0.021,
      0.021,
      zinc,
      true,
    );
  }
  const headZ = -12.8,
    lowX = -1.8,
    headX = -12.65;
  const lowY = 1.0,
    headY = 5.65;
  const pointOnBelt = (f, z, y = 0) =>
    vec(lowX + (headX - lowX) * f, lowY + (headY - lowY) * f + y, headZ + z);
  beam(metal, pointOnBelt(0, 0), pointOnBelt(1, 0), 0.12, 0.95, belt);
  for (const edge of [-0.52, 0.52]) {
    beam(metal, pointOnBelt(0, edge, 0.28), pointOnBelt(1, edge, 0.28), 0.14, 0.15, red);
    beam(metal, pointOnBelt(0, edge, -0.36), pointOnBelt(1, edge, -0.36), 0.095, 0.095, green);
    for (let i = 0; i < 12; i++) {
      beam(
        metal,
        pointOnBelt(i / 12, edge, -0.32),
        pointOnBelt((i + 1) / 12, edge, 0.22),
        0.052,
        0.052,
        greenLight,
      );
    }
  }
  for (const f of [0.12, 0.45, 0.76, 0.98]) {
    for (const side of [-0.5, 0.5]) {
      const b = pointOnBelt(f, side, -0.3);
      const a = vec(b.x + 0.32, 0, b.z + side * 0.48);
      beam(metal, a, b, 0.135, 0.135, green);
      box(civil, a.x, 0.075, a.z, 0.45, 0.15, 0.45, concrete);
    }
    const b = pointOnBelt(f, 0.5, -0.4);
    beam(metal, vec(b.x + 0.32, 0.18, headZ - 0.72), b, 0.08, 0.08, greenLight);
  }
  beam(metal, pointOnBelt(0.68, 0.85, 0.25), pointOnBelt(1, 0.85, 0.25), 0.1, 0.72, zinc);
  for (const h of [0.65, 1]) {
    beam(metal, pointOnBelt(0.68, 1.16, h), pointOnBelt(1, 1.16, h), 0.027, 0.027, orange, true);
  }
  for (const f of [0.68, 0.79, 0.9, 1]) {
    beam(metal, pointOnBelt(f, 1.16, 0.29), pointOnBelt(f, 1.16, 1.0), 0.027, 0.027, orange, true);
  }
  box(metal, headX, 5.86, headZ, 1.45, 0.83, 1.48, red);
  beam(
    metal,
    vec(headX, 5.65, headZ + 0.44),
    vec(siloX, 5.0, siloZ - 1.03),
    0.48,
    0.48,
    greenLight,
  );
  // Four sloped plates leave the receiving hopper open; bars protect the belt.
  function hopperRing(y, half) {
    return [
      [-1, -1],
      [-1, 1],
      [1, 1],
      [1, -1],
    ].map(([x, z]) => vec(lowX + x * half, y, headZ + z * half));
  }
  const inlet = hopperRing(1.55, 0.94),
    throat = hopperRing(0.53, 0.32);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(metal, throat[i], throat[j], inlet[j], inlet[i], oxidized);
    const insideA = inlet[i].clone().lerp(throat[i], 0.01);
    const insideB = inlet[j].clone().lerp(throat[j], 0.01);
    quad(metal, inlet[i], inlet[j], throat[j], throat[i], 0x67573f);
    beam(metal, insideA, insideB, 0.09, 0.09, red);
  }
  box(metal, lowX, 0.53, headZ, 0.66, 0.03, 0.66, belt);
  for (let x = -0.72; x < 0.9; x += 0.29) {
    beam(
      metal,
      vec(lowX + x, 1.54, headZ - 0.91),
      vec(lowX + x, 1.54, headZ + 0.91),
      0.032,
      0.032,
      steel,
      true,
    );
  }
  for (const dx of [-0.6, 0.6])
    for (const dz of [-0.6, 0.6]) box(metal, lowX + dx, 0.43, headZ + dz, 0.1, 0.86, 0.1, green);

  // A site cabin and a pair of portable barriers frame the entrance to the plant.
  const cabinX = -14.1,
    cabinZ = -3.75;
  box(civil, cabinX, 0.1, cabinZ, 2.54, 0.22, 4.18, concrete);
  box(metal, cabinX, 1.29, cabinZ, 2.25, 2.34, 3.94, cream);
  box(metal, cabinX, 2.51, cabinZ, 2.45, 0.16, 4.12, green);
  box(metal, cabinX, 0.36, cabinZ, 2.28, 0.23, 3.97, green);
  for (const dz of [-1.15, -0.22]) {
    box(metal, cabinX + 1.14, 1.63, cabinZ + dz, 0.05, 0.81, 0.68, zinc);
    box(metal, cabinX + 1.17, 1.63, cabinZ + dz, 0.02, 0.67, 0.56, 0x52696b);
  }
  box(metal, cabinX + 1.15, 1.16, cabinZ + 1.05, 0.05, 2.03, 0.87, green);
  box(metal, cabinX + 1.18, 1.7, cabinZ + 1.05, 0.025, 0.61, 0.62, 0x52696b);
  box(metal, cabinX + 1.2, 1.01, cabinZ + 1.35, 0.07, 0.04, 0.14, zinc);
  for (const dz of [-1.5, 1.5]) {
    box(civil, cabinX - 0.9, 0.18, cabinZ + dz, 0.35, 0.35, 0.35, joints);
  }
  for (const side of [-1, 1]) {
    const z = -9 + side * 1.5;
    box(civil, -8.2, 0.31, z, 0.44, 0.62, 2.35, concrete);
    box(civil, -8.2, 0.65, z, 0.24, 0.065, 2.3, red);
  }
  // Fixed survey stakes mark the edge of the yard.
  for (const [x, z] of [
    [-9, 5.8],
    [-9, 8.7],
    [7.8, -6.4],
    [10.9, -6.4],
  ]) {
    cylinder(civil, x, 0.42, z, 0.036, 0.84, cream);
    cylinder(civil, x, 0.77, z, 0.039, 0.17, red);
  }
  rock.finish();
  civil.finish();
  metal.finish();
  groundCover.finish();
  for (const primitive of [unitBox, cylinder8, cylinder24, stoneShape]) primitive.dispose();

  scene.background = new T.Color(0xe0d3b9);
  scene.fog = new T.FogExp2(0xd3d0ba, 0.015);
  const sky = new T.Mesh(
    new T.SphereGeometry(118, 44, 22),
    new T.ShaderMaterial({
      side: T.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        horizon: { value: new T.Color(0xe9d7b8) },
        upper: { value: new T.Color(0x89b6c6) },
      },
      vertexShader: `varying vec3 vDirection;
      void main() { vDirection = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vDirection; uniform vec3 horizon; uniform vec3 upper;
      void main() {
        vec3 d=normalize(vDirection);
        float y=max(d.y,0.0);
        vec3 sky=mix(horizon,upper,smoothstep(-.03,.62,y));
        float sun=max(dot(d,normalize(vec3(-.66,.78,.56))),0.);
        sky+=vec3(.26,.18,.09)*pow(sun,15.) + vec3(.9,.72,.43)*smoothstep(.9993,.9998,sun);
        gl_FragColor=vec4(sky,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    }),
  );
  sky.name = 'Morning sky';
  sky.renderOrder = -10;
  scene.add(sky);
  const ambient = new T.HemisphereLight(0xe6edfa, 0xc7ac91, 1.55);
  const sunlight = new T.DirectionalLight(0xffe9c5, 2.55);
  sunlight.position.set(-15, 21, 13);
  sunlight.target.position.set(0, 0, 0);
  sunlight.castShadow = true;
  sunlight.shadow.mapSize.set(1024, 1024);
  Object.assign(sunlight.shadow.camera, {
    left: -15,
    right: 15,
    top: 15,
    bottom: -15,
    near: 0.5,
    far: 65,
  });
  sunlight.shadow.camera.updateProjectionMatrix();
  sunlight.shadow.normalBias = 0.025;
  sunlight.shadow.bias = -0.00028;
  scene.add(ambient, sunlight, sunlight.target);
  return { root: site, sunlight, bay: WEIGH_BAY };
}

function makeSign(T, group, caption, number, position, yaw, width, height) {
  // One shared plate graphic reads from either side of the weigh bin.
  if (typeof document === 'undefined') return;
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 192;
  const g = canvas.getContext('2d');
  g.fillStyle = '#243b3a';
  g.fillRect(0, 0, 384, 192);
  g.strokeStyle = '#cbbf9e';
  g.lineWidth = 5;
  g.strokeRect(9, 9, 366, 174);
  g.fillStyle = '#e7dec4';
  g.font = 'bold 32px sans-serif';
  g.fillText(caption, 22, 55);
  g.fillStyle = '#eeb14a';
  g.font = 'bold 106px sans-serif';
  g.fillText(number, 20, 160);
  const tex = new T.CanvasTexture(canvas);
  tex.colorSpace = T.SRGBColorSpace;
  const plate = new T.Mesh(
    new T.PlaneGeometry(width, height),
    new T.MeshStandardMaterial({ map: tex, roughness: 0.83 }),
  );
  plate.position.copy(position);
  plate.rotation.y = yaw;
  plate.receiveShadow = true;
  group.add(plate);
}
