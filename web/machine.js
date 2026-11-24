// Dimensions in metres, +X forward, +Y up. Section profiles and mounting
// points are shared by the visual rig and the tooth-space game contract.
export const machineDimensions = Object.freeze({
  shoulder: [0.55, 1.55],
  boom: 4.45,
  stick: 2.65,
  tooth: [0.86, -0.52],
  limits: { boom: [-0.18, 1.19], stick: [-2.55, -0.35], curl: [-1.15, 2.35] },
});

const colors = {
  sun: '#f5b324',
  gold: '#d99415',
  light: '#ffd35b',
  dark: '#232b2c',
  rubber: '#303331',
  frame: '#3e4645',
  graphite: '#181e20',
  steel: '#677071',
  wear: '#9d9890',
  chrome: '#d8e4e4',
  glass: '#74a8a9',
};

export function createMachine(THREE) {
  const T = THREE;
  const root = new T.Group();
  root.name = 'Tracked excavator';
  const v = (x, y, z) => new T.Vector3(x, y, z);
  const clamp = (value, a, b) => Math.max(a, Math.min(b, value));
  const surfaces = {
    enamel: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.14 }),
    alloy: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.53, metalness: 0.42 }),
    bright: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.23, metalness: 0.52 }),
    glazing: new T.MeshStandardMaterial({
      color: colors.glass,
      transparent: true,
      opacity: 0.46,
      metalness: 0.1,
      roughness: 0.17,
      depthWrite: false,
      side: T.DoubleSide,
    }),
  };
  // A fixed-seed, tileable micro-finish breaks up paint and dusty metal at
  // bucket distance. It is generated once on the CPU, shared across finishes.
  const tileSize = 128,
    grain = new Uint8Array(tileSize * tileSize * 4);
  const rough = new Uint8Array(grain.length);
  let seed = 13689504;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  for (let i = 0; i < grain.length; i += 4) {
    const value = 229 + Math.floor(26 * random());
    grain.set([value, value, value, 255], i);
    const smooth = 150 + Math.floor(102 * random());
    rough.set([smooth, smooth, smooth, 255], i);
  }
  for (let i = 0; i < 62; i++) {
    const x = Math.floor(random() * tileSize),
      y = Math.floor(random() * tileSize);
    const span = 2 + Math.floor(random() * 7);
    for (let j = 0; j < span; j++) {
      const idx = (((y + Math.floor(j * 0.25)) % tileSize) * tileSize + ((x + j) % tileSize)) * 4;
      grain.set([202, 200, 195, 255], idx);
      rough.set([112, 112, 112, 255], idx);
    }
  }
  function tile(pixels, srgb) {
    const tex = new T.DataTexture(pixels, tileSize, tileSize, T.RGBAFormat);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.magFilter = T.LinearFilter;
    tex.minFilter = T.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    if (srgb) tex.colorSpace = T.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }
  const patina = tile(grain, true),
    roughness = tile(rough, false);
  for (const finish of [surfaces.enamel, surfaces.alloy]) {
    finish.map = patina;
    finish.roughnessMap = roughness;
  }
  const batch = new Map();
  const materialColor = new T.Color();
  function group(name, parent, x = 0, y = 0, z = 0) {
    const g = new T.Group();
    g.name = name;
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  }

  // Bake fixed components once per moving assembly and surface finish.
  // Geometry stays in the assembly's own coordinates for cheap joint motion.
  function emit(part, geom, color, finish = 'enamel') {
    let surfacesByPart = batch.get(part);
    if (!surfacesByPart) batch.set(part, (surfacesByPart = new Map()));
    let out = surfacesByPart.get(finish);
    if (!out) surfacesByPart.set(finish, (out = { p: [], n: [], c: [], uv: [] }));
    materialColor.set(color);
    const { position, normal } = geom.attributes;
    const index = geom.index;
    const count = index ? index.count : position.count;
    for (let i = 0; i < count; i++) {
      const j = index ? index.getX(i) : i;
      const x = position.getX(j),
        y = position.getY(j),
        z = position.getZ(j);
      const nx = normal.getX(j),
        ny = normal.getY(j),
        nz = normal.getZ(j);
      out.p.push(x, y, z);
      out.n.push(nx, ny, nz);
      out.c.push(materialColor.r, materialColor.g, materialColor.b);
      const ax = Math.abs(nx),
        ay = Math.abs(ny),
        az = Math.abs(nz);
      if (ay > ax && ay > az) out.uv.push(x * 1.15, z * 1.15);
      else if (ax > az) out.uv.push(z * 1.15, y * 1.15);
      else out.uv.push(x * 1.15, y * 1.15);
    }
    geom.dispose();
  }
  function box(part, x, y, z, sx, sy, sz, color, finish = 'enamel', angle = 0) {
    const geom = new T.BoxGeometry(sx, sy, sz);
    geom.rotateZ(angle).translate(x, y, z);
    emit(part, geom, color, finish);
  }
  function plate(part, outline, z, width, color, bevel = 0.025, finish = 'enamel') {
    const path = new T.Shape(outline.map((p) => new T.Vector2(...p)));
    const geom = new T.ExtrudeGeometry(path, {
      depth: width,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 2,
      curveSegments: 2,
    });
    geom.translate(0, 0, z - width / 2);
    emit(part, geom, color, finish);
  }
  const up = v(0, 1, 0);
  function bar(part, a, b, radius, color, finish = 'alloy', sides = 10, topRadius = radius) {
    const from = v(...a),
      to = v(...b),
      delta = to.clone().sub(from);
    const geom = new T.CylinderGeometry(topRadius, radius, delta.length(), sides);
    geom.applyQuaternion(new T.Quaternion().setFromUnitVectors(up, delta.normalize()));
    const center = from.lerp(to, 0.5);
    geom.translate(center.x, center.y, center.z);
    emit(part, geom, color, finish);
  }
  function pipe(part, points, radius, color, finish = 'alloy') {
    const curve = new T.CatmullRomCurve3(
      points.map((p) => v(...p)),
      false,
      'centripetal',
    );
    emit(part, new T.TubeGeometry(curve, points.length * 3, radius, 6, false), color, finish);
  }
  function axle(part, x, y, z, radius, width, color, count = 20, finish = 'alloy') {
    bar(part, [x, y, z - width / 2], [x, y, z + width / 2], radius, color, finish, count);
  }
  function pin(part, x, y, halfWidth, radius) {
    axle(part, x, y, 0, radius, halfWidth * 2, colors.frame);
    for (const side of [-1, 1]) {
      axle(part, x, y, side * (halfWidth + 0.015), radius * 1.18, 0.032, colors.wear, 16);
      axle(part, x, y, side * (halfWidth + 0.041), radius * 0.55, 0.021, colors.graphite, 6);
    }
  }
  function loft(part, rings, color, finish = 'enamel') {
    // Rings have the same clockwise order when viewed from above.
    const p = [];
    const tri = (a, b, c) => p.push(...a, ...b, ...c);
    const count = rings[0].length;
    for (let r = 1; r < rings.length; r++) {
      for (let i = 0; i < count; i++) {
        const j = (i + 1) % count,
          low = rings[r - 1],
          high = rings[r];
        tri(low[i], high[i], high[j]);
        tri(low[i], high[j], low[j]);
      }
    }
    const caps = T.ShapeUtils.triangulateShape(
      rings[0].map(([x, , z]) => new T.Vector2(x, z)),
      [],
    );
    for (const [a, b, c] of caps) {
      tri(rings[0][a], rings[0][b], rings[0][c]);
      const top = rings[rings.length - 1];
      tri(top[a], top[c], top[b]);
    }
    const geom = new T.BufferGeometry();
    geom.setAttribute('position', new T.Float32BufferAttribute(p, 3));
    geom.computeVertexNormals();
    emit(part, geom, color, finish);
  }
  function windowPane(parent, points) {
    const geom = new T.BufferGeometry();
    geom.setAttribute('position', new T.Float32BufferAttribute(points.flat(), 3));
    geom.setIndex([0, 1, 2, 0, 2, 3]);
    geom.computeVertexNormals();
    const mesh = new T.Mesh(geom, surfaces.glazing);
    mesh.name = 'Tinted cab glass';
    parent.add(mesh);
  }
  const house = group('Slew ring / upper carriage', root);
  const boom = group('Boom pin', house, ...machineDimensions.shoulder);
  const stick = group('Stick pin', boom, machineDimensions.boom);
  const bucket = group('Bucket pin', stick, machineDimensions.stick);
  const tip = group('Centre cutting tooth', bucket, ...machineDimensions.tooth);

  // Undercarriage: carrier, inset side frames, final drives, idlers and rollers.
  box(root, 0, 0.65, 0, 2.45, 0.41, 1.98, colors.frame, 'alloy');
  for (const x of [-0.91, 0.91]) {
    box(root, x, 0.54, 0, 0.39, 0.26, 2.4, colors.dark, 'alloy');
  }
  const rollerSpacing = 1.62,
    wheelY = 0.51,
    beltRadius = 0.45;
  const trackCircumference = 4 * rollerSpacing + 2 * Math.PI * beltRadius;
  const pathSample = (distance, out) => {
    let s = ((distance % trackCircumference) + trackCircumference) % trackCircumference;
    const span = 2 * rollerSpacing,
      arc = Math.PI * beltRadius;
    if (s < span) return out.set(-rollerSpacing + s, wheelY + beltRadius, 0);
    s -= span;
    if (s < arc) {
      const t = s / beltRadius;
      return out.set(
        rollerSpacing + beltRadius * Math.sin(t),
        wheelY + beltRadius * Math.cos(t),
        -t,
      );
    }
    s -= arc;
    if (s < span) return out.set(rollerSpacing - s, wheelY - beltRadius, Math.PI);
    const t = (s - span) / beltRadius;
    return out.set(
      -rollerSpacing - beltRadius * Math.sin(t),
      wheelY - beltRadius * Math.cos(t),
      Math.PI - t,
    );
  };
  for (const z of [-1.09, 1.09]) {
    const side = Math.sign(z);
    plate(
      root,
      [
        [-1.61, 0.31],
        [-1.73, 0.53],
        [-1.48, 0.76],
        [-0.98, 0.81],
        [1.33, 0.8],
        [1.7, 0.63],
        [1.62, 0.35],
      ],
      z,
      0.44,
      colors.dark,
      0.04,
      'alloy',
    );
    for (let i = 0; i < 7; i++) {
      const x = -1.29 + i * 0.43;
      axle(root, x, 0.32, z, 0.207, 0.45, colors.rubber);
      axle(root, x, 0.32, z + side * 0.24, 0.13, 0.035, colors.frame, 12);
      axle(root, x, 0.32, z + side * 0.266, 0.055, 0.025, colors.wear, 6);
    }
    for (const x of [-rollerSpacing, rollerSpacing]) {
      const drive = x < 0;
      axle(root, x, wheelY, z, 0.395, 0.39, colors.frame, 30);
      axle(root, x, wheelY, z + side * 0.222, 0.29, 0.06, drive ? colors.gold : colors.steel);
      axle(root, x, wheelY, z + side * 0.266, 0.15, 0.06, colors.frame);
      for (let j = 0; j < 8; j++) {
        const a = (j * Math.PI) / 4;
        axle(
          root,
          x + 0.22 * Math.cos(a),
          wheelY + 0.22 * Math.sin(a),
          z + side * 0.265,
          0.028,
          0.035,
          drive ? colors.graphite : colors.wear,
          6,
        );
      }
    }
    for (const x of [-0.86, 0.76]) axle(root, x, 0.8, z, 0.12, 0.44, colors.steel);
  }
  // One instanced grouser-and-shoe assembly per link, wrapped continuously.
  const shoePart = new T.Group();
  box(shoePart, 0, 0, 0, 0.183, 0.077, 0.68, colors.rubber, 'alloy');
  box(shoePart, -0.047, 0.047, 0, 0.041, 0.024, 0.66, colors.wear, 'alloy');
  for (const side of [-1, 1])
    box(shoePart, 0.025, 0.042, 0.24 * side, 0.09, 0.016, 0.075, colors.steel, 'alloy');
  const slewCenter = [0, 1.13, 0];
  bar(root, [0, 0.83, 0], slewCenter, 0.94, colors.graphite, 'alloy', 36);
  bar(root, [0, 1.045, 0], [0, 1.09, 0], 0.96, colors.wear, 'alloy', 36);

  // Plan-view rings preserve the sweep of the counterweight around the rear.
  const plan = [
    [-2.17, -0.56],
    [-2.04, -0.98],
    [-1.7, -1.23],
    [-1.25, -1.32],
    [0.94, -1.32],
    [1.31, -1.05],
    [1.43, -0.8],
    [1.43, 1.09],
    [1.16, 1.3],
    [-1.12, 1.3],
    [-1.66, 1.17],
    [-2.02, 0.92],
    [-2.17, 0.57],
  ];
  const ring = (loop, y, sx, sz) => loop.map(([x, z]) => [x * sx, y, z * sz]);
  loft(
    house,
    [ring(plan, 1.12, 0.95, 0.96), ring(plan, 1.18, 1, 1), ring(plan, 1.38, 1, 1)],
    colors.dark,
    'alloy',
  );
  const stern = [
    [-2.13, -0.54],
    [-1.99, -0.97],
    [-1.62, -1.21],
    [-1.12, -1.26],
    [0.81, -1.26],
    [0.98, -1.11],
    [0.98, -0.42],
    [0.5, -0.32],
    [-0.83, -0.32],
    [-0.83, 1.19],
    [-1.29, 1.22],
    [-1.7, 1.09],
    [-2.0, 0.84],
    [-2.13, 0.52],
  ];
  loft(
    house,
    [
      ring(stern, 1.39, 0.97, 0.97),
      ring(stern, 1.49, 1, 1),
      ring(stern, 1.91, 1, 1),
      ring(stern, 2.04, 0.964, 0.935),
    ],
    colors.sun,
  );
  // Engine hatch and louvres on the hood and the service side.
  plate(
    house,
    [
      [-1.6, 2.0],
      [-1.49, 2.21],
      [-1.25, 2.3],
      [-0.5, 2.3],
      [-0.29, 2.08],
    ],
    -0.47,
    1.01,
    colors.gold,
    0.045,
  );
  for (let i = 0; i < 12; i++) {
    box(house, -1.28 + i * 0.067, 2.347, -0.52, 0.032, 0.03, 0.68, colors.dark, 'alloy');
    box(house, -1.2 + i * 0.088, 1.79, -1.264, 0.042, 0.24, 0.019, colors.graphite, 'alloy', -0.15);
  }
  for (const side of [-1, 1]) {
    const z = side * 1.29;
    box(house, -1.1, 1.5, z, 0.55, 0.07, 0.018, colors.light);
    box(house, -1.12, 1.56, z, 0.53, 0.037, 0.018, colors.graphite);
  }
  // Tail face between the two aft radii. Recessed light pods, tow bosses
  // and service panels make the rear recognizable when the house slews away.
  for (const side of [-1, 1]) {
    box(house, -2.137, 1.76, side * 0.405, 0.045, 0.125, 0.23, colors.dark, 'alloy');
    box(house, -2.165, 1.772, side * 0.41, 0.016, 0.056, 0.15, '#ba3a20', 'bright');
    box(house, -2.167, 1.73, side * 0.41, 0.016, 0.018, 0.15, '#f9d28b', 'bright');
    axle(house, -1.7, 1.35, side * 0.9, 0.065, 0.082, colors.steel, 12);
  }
  box(house, -2.154, 1.684, 0, 0.016, 0.054, 0.54, colors.graphite, 'alloy');
  for (let i = 0; i < 4; i++) {
    const x = -0.95 + i * 0.28;
    axle(house, x, 1.56, -1.267, 0.021, 0.022, colors.steel, 6);
  }
  pipe(
    house,
    [
      [-1.54, 2.07, -0.38],
      [-1.54, 2.46, -0.38],
      [-1.63, 2.58, -0.38],
      [-1.73, 2.6, -0.38],
    ],
    0.065,
    colors.graphite,
  );
  bar(house, [-1.54, 2.11, -0.38], [-1.54, 2.29, -0.38], 0.099, colors.steel);

  // The cab has an open interior with independent, inset panes and the
  // characteristic raked windshield. Window seals and steel posts are solid.
  const cab = group('Operator cab', house);
  const cabCenter = 0.82,
    halfCab = 0.44;
  plate(
    cab,
    [
      [-0.82, 1.44],
      [1.2, 1.44],
      [1.26, 1.75],
      [1.12, 1.95],
      [-0.66, 1.95],
      [-0.82, 1.77],
    ],
    cabCenter,
    0.91,
    colors.sun,
    0.034,
  );
  plate(
    cab,
    [
      [-0.5, 1.5],
      [0.83, 1.5],
      [0.96, 1.56],
      [0.99, 1.85],
      [-0.5, 1.85],
    ],
    1.318,
    0.01,
    colors.gold,
    0.009,
  );
  plate(
    cab,
    [
      [-0.48, 1.53],
      [0.81, 1.53],
      [0.93, 1.58],
      [0.95, 1.82],
      [-0.48, 1.82],
    ],
    1.336,
    0.008,
    colors.sun,
    0.005,
  );
  box(cab, -0.29, 1.79, 1.352, 0.16, 0.041, 0.026, colors.graphite);
  box(cab, -0.29, 1.795, 1.372, 0.092, 0.017, 0.012, colors.steel, 'alloy');
  const sideProfile = [
    [-0.7, 1.91],
    [1.14, 1.91],
    [1.07, 2.28],
    [0.78, 3.15],
    [-0.5, 3.17],
    [-0.68, 2.96],
  ];
  for (const side of [-1, 1]) {
    const z = cabCenter + side * halfCab;
    sideProfile.forEach((p, i) => {
      const q = sideProfile[(i + 1) % sideProfile.length];
      bar(cab, [...p, z], [...q, z], 0.045, colors.graphite, 'enamel', 8);
    });
    bar(cab, [0.1, 1.91, z], [0.08, 3.15, z], 0.036, colors.graphite);
    bar(cab, [0.1, 2.19, z], [1.08, 2.23, z], 0.023, colors.dark);
    const inset = z - side * 0.019;
    windowPane(cab, [
      [-0.64, 1.96, inset],
      [0.065, 1.96, inset],
      [0.045, 3.1, inset],
      [-0.48, 3.1, inset],
    ]);
    windowPane(cab, [
      [0.14, 1.96, inset],
      [1.09, 1.96, inset],
      [0.75, 3.1, inset],
      [0.12, 3.1, inset],
    ]);
  }
  for (const [x, y] of [sideProfile[1], sideProfile[3], sideProfile[4]]) {
    bar(cab, [x, y, cabCenter - halfCab], [x, y, cabCenter + halfCab], 0.048, colors.graphite);
  }
  windowPane(cab, [
    [1.13, 1.97, 0.415],
    [1.13, 1.97, 1.23],
    [0.77, 3.1, 1.23],
    [0.77, 3.1, 0.415],
  ]);
  windowPane(cab, [
    [-0.65, 1.98, 0.415],
    [-0.65, 1.98, 1.23],
    [-0.53, 3.03, 1.23],
    [-0.53, 3.03, 0.415],
  ]);
  pipe(
    cab,
    [
      [1.05, 2.23, 1.14],
      [0.93, 2.63, 0.8],
      [0.89, 2.79, 0.57],
    ],
    0.014,
    colors.graphite,
  );
  plate(
    cab,
    [
      [-0.69, 3.13],
      [-0.54, 3.25],
      [0.68, 3.25],
      [0.9, 3.17],
      [0.79, 3.13],
    ],
    cabCenter,
    1.0,
    colors.sun,
    0.026,
  );
  box(cab, -0.3, 2.01, cabCenter, 0.48, 0.14, 0.49, colors.graphite);
  box(cab, -0.48, 2.23, cabCenter, 0.12, 0.5, 0.45, colors.frame, 'enamel', 0.12);
  box(cab, -0.5, 2.52, cabCenter, 0.12, 0.14, 0.31, colors.graphite, 'enamel', 0.12);
  for (const z of [0.54, 1.1]) {
    bar(cab, [-0.08, 1.97, z], [0.03, 2.18, z], 0.022, colors.steel);
    bar(cab, [0.03, 2.18, z], [0.027, 2.24, z], 0.036, colors.graphite);
  }
  box(cab, 0.72, 2.01, 0.57, 0.15, 0.22, 0.2, colors.dark);
  box(cab, 0.633, 2.04, 0.57, 0.013, 0.13, 0.16, '#699c99');
  pipe(
    cab,
    [
      [-0.42, 1.94, 1.307],
      [-0.38, 2.23, 1.32],
      [-0.33, 2.24, 1.32],
    ],
    0.026,
    colors.graphite,
  );
  box(house, 0.04, 1.28, 1.4, 1.02, 0.09, 0.18, colors.steel, 'alloy');
  for (let i = 0; i < 12; i++)
    box(house, -0.43 + i * 0.085, 1.333, 1.4, 0.025, 0.022, 0.15, colors.graphite);
  for (const z of [0.49, 1.15]) {
    box(cab, 0.81, 3.2, z, 0.13, 0.12, 0.17, colors.graphite);
    box(cab, 0.883, 3.2, z, 0.018, 0.083, 0.125, '#ffead0', 'bright');
  }
  bar(house, [-1.29, 2.08, 0.48], [-1.29, 2.61, 0.48], 0.026, colors.graphite);
  bar(house, [-1.29, 2.61, 0.48], [-1.29, 2.77, 0.48], 0.073, '#ed781e', 'bright');
  // Walkway and railing on the service side.
  pipe(
    house,
    [
      [0.93, 1.45, -1.28],
      [0.93, 2.25, -1.28],
      [0.8, 2.37, -1.28],
      [0.2, 2.37, -1.28],
      [0.12, 2.26, -1.28],
      [0.12, 1.58, -1.28],
    ],
    0.035,
    colors.graphite,
  );

  for (const side of [-1, 1]) {
    plate(
      house,
      [
        [0.18, 1.38],
        [0.88, 1.38],
        [0.76, 1.71],
        [0.5, 1.77],
        [0.25, 1.6],
      ],
      side * 0.302,
      0.092,
      colors.gold,
      0.024,
    );
  }
  const boomPlate = [
    [-0.17, -0.1],
    [-0.1, -0.24],
    [0.21, -0.25],
    [1.3, 0.13],
    [2.06, 0.29],
    [3.76, -0.16],
    [4.4, -0.17],
    [4.59, -0.09],
    [4.62, 0.05],
    [4.47, 0.18],
    [3.97, 0.22],
    [2.23, 0.81],
    [1.75, 0.85],
    [1.31, 0.72],
    [0.47, 0.32],
    [0.02, 0.19],
    [-0.15, 0.12],
  ];
  plate(boom, boomPlate, 0, 0.4, colors.sun, 0.037);
  for (const side of [-1, 1]) {
    plate(
      boom,
      [
        [1.22, 0.12],
        [1.57, 0.16],
        [2.08, 0.19],
        [2.78, 0.09],
        [2.45, 0.37],
        [1.8, 0.42],
      ],
      side * 0.247,
      0.011,
      colors.gold,
      0.009,
    );
    pipe(
      boom,
      [
        [0.1, 0.23, side * 0.21],
        [0.98, 0.59, side * 0.21],
        [1.6, 0.89, side * 0.21],
        [2.13, 0.88, side * 0.21],
        [3.21, 0.52, side * 0.17],
        [4.05, 0.29, side * 0.18],
      ],
      0.025,
      colors.graphite,
    );
    for (const [x, y] of [
      [0.97, 0.58],
      [1.58, 0.86],
      [2.12, 0.85],
      [3.24, 0.49],
    ])
      box(boom, x, y, side * 0.205, 0.045, 0.08, 0.08, colors.steel, 'alloy');
  }
  pin(boom, 0, 0, 0.371, 0.118);
  const stickPlate = [
    [-0.43, 0.05],
    [-0.53, 0.31],
    [-0.37, 0.48],
    [0.03, 0.32],
    [0.46, 0.29],
    [1.21, 0.21],
    [2.51, 0.13],
    [2.74, 0.09],
    [2.79, -0.05],
    [2.7, -0.15],
    [2.45, -0.14],
    [1.34, -0.17],
    [0.62, -0.2],
    [0.1, -0.24],
    [-0.15, -0.17],
  ];
  plate(stick, stickPlate, 0, 0.29, colors.sun, 0.024);
  for (const side of [-1, 1]) {
    plate(
      boom,
      [
        [3.95, -0.145],
        [4.45, -0.15],
        [4.57, -0.08],
        [4.57, 0.08],
        [4.45, 0.151],
        [3.96, 0.17],
      ],
      side * 0.237,
      0.049,
      colors.gold,
      0.014,
    );
    pipe(
      stick,
      [
        [0.08, 0.32, side * 0.16],
        [0.38, 0.37, side * 0.16],
        [0.84, 0.31, side * 0.16],
        [1.63, 0.24, side * 0.15],
        [2.15, 0.2, side * 0.15],
      ],
      0.024,
      colors.graphite,
    );
  }
  pin(stick, 0, 0, 0.292, 0.112);
  // Rolled bucket back is a thick open extrusion. Only the cheeks close the
  // sides. The open top remains visible from behind the cutting edge.
  const shell = [
    [-0.33, 0.09],
    [-0.53, -0.04],
    [-0.64, -0.25],
    [-0.63, -0.46],
    [-0.51, -0.68],
    [-0.28, -0.82],
    [0.0, -0.86],
    [0.24, -0.82],
    [0.66, -0.62],
    [0.72, -0.55],
    [0.64, -0.55],
    [0.2, -0.74],
    [-0.02, -0.77],
    [-0.24, -0.73],
    [-0.44, -0.61],
    [-0.52, -0.45],
    [-0.54, -0.27],
    [-0.46, -0.1],
    [-0.29, 0.0],
  ];
  plate(bucket, shell, 0, 1.07, colors.steel, 0.012, 'alloy');
  const cheek = [
    [-0.34, 0.08],
    [-0.54, -0.055],
    [-0.63, -0.28],
    [-0.6, -0.5],
    [-0.43, -0.71],
    [-0.18, -0.81],
    [0.12, -0.81],
    [0.68, -0.6],
    [0.6, -0.49],
    [0.16, -0.33],
    [-0.04, -0.084],
    [-0.14, 0.038],
  ];
  for (const side of [-1, 1]) {
    plate(bucket, cheek, side * 0.555, 0.045, colors.graphite, 0.012, 'alloy');
    plate(
      bucket,
      [
        [-0.34, 0.17],
        [-0.23, 0.29],
        [-0.09, 0.23],
        [0.1, 0.09],
        [0.1, -0.1],
        [-0.19, -0.29],
        [-0.52, -0.33],
        [-0.49, -0.12],
      ],
      side * 0.203,
      0.085,
      colors.frame,
      0.014,
      'alloy',
    );
    plate(
      bucket,
      [
        [-0.5, -0.59],
        [-0.37, -0.72],
        [-0.08, -0.81],
        [0.14, -0.79],
        [0.55, -0.62],
        [0.41, -0.63],
        [-0.08, -0.72],
      ],
      side * 0.588,
      0.013,
      colors.wear,
      0.007,
      'alloy',
    );
  }
  box(bucket, 0.63, -0.597, 0, 0.13, 0.12, 1.18, colors.wear, 'alloy', 0.25);
  for (const z of [-0.48, -0.24, 0, 0.24, 0.48]) {
    plate(
      bucket,
      [
        [0.55, -0.61],
        [0.68, -0.65],
        [0.86, -0.528],
        [0.86, -0.512],
        [0.68, -0.52],
        [0.54, -0.54],
      ],
      z,
      0.112,
      colors.wear,
      0.006,
      'alloy',
    );
  }
  pin(bucket, 0, 0, 0.267, 0.095);
  const sand = group('Retained bucket load', bucket, 0, -0.745, 0);
  // Crown is biased toward the heel, below the opening of the open scoop.
  const mound = [
    [-0.39, -0.26],
    [-0.25, -0.49],
    [0.24, -0.49],
    [0.49, -0.36],
    [0.55, 0.22],
    [0.34, 0.49],
    [-0.25, 0.49],
    [-0.43, 0.26],
  ];
  loft(
    sand,
    [
      ring(mound, 0.01, 0.72, 0.83),
      ring(mound, 0.2, 1, 1),
      ring(mound, 0.36, 0.79, 0.82),
      ring(mound, 0.46, 0.33, 0.41),
    ],
    '#c29b63',
  );

  // Lettering is vector-rasterized locally into a tiny alpha-tested atlas.
  // Each panel is offset from its own mounting face along the surface normal.
  function lettering(part, text, width, height, x, y, z, angle, flip = false) {
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#202628';
    ctx.font = '900 italic 73px Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, 256, 50, 490);
    const texture = new T.CanvasTexture(canvas);
    texture.colorSpace = T.SRGBColorSpace;
    const face = new T.Mesh(
      new T.PlaneGeometry(width, height),
      new T.MeshBasicMaterial({
        map: texture,
        alphaTest: 0.45,
        toneMapped: false,
      }),
    );
    face.name = 'Painted ' + text;
    face.position.set(x, y, z);
    face.rotation.order = 'ZYX';
    face.rotation.z = angle;
    face.rotation.y = flip ? Math.PI : 0;
    part.add(face);
  }
  for (const sign of [-1, 1]) {
    lettering(boom, 'SANDLAB', 1.04, 0.21, 2.93, 0.19, sign * 0.241, -0.18, sign < 0);
  }
  lettering(cab, 'TL 220', 0.64, 0.16, 0.4, 1.66, 1.35, 0);
  lettering(house, 'TL 220', 0.57, 0.13, 0.36, 1.75, -1.272, 0, true);

  // Fixed-length barrel with a gland and a piston that emerges to its far
  // mount. Only four 2D pin calculations are needed for the actuators.
  const actuators = [];
  function hydraulic(parent, name, a, length, radius) {
    const barrel = group(name + ' / barrel', parent, ...a);
    const rod = group(name + ' / exposed rod', barrel, length, 0, 0);
    bar(barrel, [0.055, 0, 0], [length, 0, 0], radius, colors.gold, 'enamel', 14);
    bar(barrel, [0.13, 0, 0], [0.18, 0, 0], radius * 1.08, colors.graphite, 'alloy', 14);
    bar(
      barrel,
      [length - 0.065, 0, 0],
      [length + 0.006, 0, 0],
      radius * 1.11,
      colors.graphite,
      'alloy',
      14,
    );
    axle(barrel, 0, 0, 0, radius * 1.08, radius * 1.88, colors.steel, 14);
    bar(rod, [0, 0, 0], [1, 0, 0], radius * 0.53, colors.chrome, 'bright', 12);
    const record = { name, barrel, rod, barrelLength: length, distance: 0, extension: 0 };
    actuators.push(record);
    return (x, y) => {
      const dx = x - a[0],
        dy = y - a[1],
        d = Math.hypot(dx, dy);
      record.distance = d;
      record.extension = d - length;
      barrel.rotation.z = Math.atan2(dy, dx);
      rod.scale.x = Math.max(0.001, record.extension);
    };
  }
  const boomDrivers = [-1, 1].map((side) => {
    const z = 0.4 * side;
    axle(boom, 1.7, 0.34, z, 0.112, 0.15, colors.gold, 16, 'enamel');
    return hydraulic(house, 'Boom lift ' + side, [0.92, 1.42, z], 1.09, 0.101);
  });
  const stickDriver = hydraulic(boom, 'Stick cylinder', [1.5, 0.77, 0], 2.33, 0.106);
  pin(stick, -0.37, 0.39, 0.181, 0.074);
  // A four-bar linkage drives the bucket. Solve both link lengths with a
  // circle intersection. The selected branch puts the knuckle above the arm.
  const dogAnchor = [2.15, 0.14],
    dogLength = 0.54,
    linkLength = 0.59;
  const lug = [-0.29, 0.22];
  pin(stick, ...dogAnchor, 0.227, 0.079);
  pin(bucket, ...lug, 0.286, 0.073);
  const rocker = group('Bucket bellcrank', stick, ...dogAnchor);
  const link = group('Bucket dogbone', stick);
  for (const side of [-1, 1]) {
    const z = side * 0.235;
    for (const [part, len, width] of [
      [rocker, dogLength, 0.058],
      [link, linkLength, 0.048],
    ]) {
      const y = part === rocker ? 0.075 : 0.065;
      const shape = [
        [-0.05, -y * 0.6],
        [0.02, -y],
        [len - 0.015, -y],
        [len + 0.06, -0.026],
        [len + 0.06, 0.027],
        [len - 0.015, y],
        [0.035, y],
        [-0.05, y * 0.6],
      ];
      plate(part, shape, part === rocker ? z : side * 0.298, width, colors.gold, 0.009);
    }
  }
  pin(rocker, dogLength, 0, 0.337, 0.065);
  const curlDriver = hydraulic(stick, 'Bucket crowd', [0.34, 0.38, 0], 1.36, 0.083);
  function buildBuffers(attr) {
    const geom = new T.BufferGeometry();
    geom.setAttribute('position', new T.Float32BufferAttribute(attr.p, 3));
    geom.setAttribute('normal', new T.Float32BufferAttribute(attr.n, 3));
    geom.setAttribute('color', new T.Float32BufferAttribute(attr.c, 3));
    geom.setAttribute('uv', new T.Float32BufferAttribute(attr.uv, 2));
    geom.computeBoundingSphere();
    return geom;
  }
  const shoeCount = 48;
  const shoeMesh = new T.InstancedMesh(
    buildBuffers(batch.get(shoePart).get('alloy')),
    surfaces.alloy,
    shoeCount * 2,
  );
  batch.delete(shoePart);
  shoeMesh.name = 'Continuous track shoes';
  shoeMesh.castShadow = shoeMesh.receiveShadow = true;
  shoeMesh.boundingSphere = new T.Sphere(v(0, wheelY, 0), 2.72);
  shoeMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
  root.add(shoeMesh);
  for (const [part, subsets] of batch) {
    for (const [name, attrs] of subsets) {
      const geom = buildBuffers(attrs),
        mesh = new T.Mesh(geom, surfaces[name]);
      mesh.name = part.name + ' / ' + name;
      mesh.castShadow = mesh.receiveShadow = true;
      part.add(mesh);
    }
  }
  batch.clear();
  const shoeTransform = new T.Object3D(),
    sample = v(0, 0, 0);
  let previousTravel = NaN;
  let previousTurn = NaN;
  function setTracks(travel, turn) {
    if (previousTravel === travel && previousTurn === turn) return;
    previousTravel = travel;
    previousTurn = turn;
    for (let i = 0; i < shoeCount; i++) {
      for (let side = 0; side < 2; side++) {
        const lateral = side ? 1.09 : -1.09;
        pathSample((i * trackCircumference) / shoeCount + travel + lateral * turn, sample);
        shoeTransform.rotation.z = sample.z;
        shoeTransform.position.set(sample.x, sample.y, lateral);
        shoeTransform.updateMatrix();
        shoeMesh.setMatrixAt(i * 2 + side, shoeTransform.matrix);
      }
    }
    shoeMesh.instanceMatrix.needsUpdate = true;
  }
  const limits = machineDimensions.limits;
  function pose({
    boom: b = 0.67,
    stick: s = -1.73,
    curl: c = 1.1,
    yaw = 0,
    load = 0,
    travel = 0,
    turn = 0,
  } = {}) {
    b = clamp(b, ...limits.boom);
    s = clamp(s, ...limits.stick);
    c = clamp(c, ...limits.curl);
    house.rotation.y = yaw;
    boom.rotation.z = b;
    stick.rotation.z = s;
    bucket.rotation.z = c;
    const bx = 0.55 + 1.7 * Math.cos(b) - 0.34 * Math.sin(b);
    const by = 1.55 + 1.7 * Math.sin(b) + 0.34 * Math.cos(b);
    for (const drive of boomDrivers) drive(bx, by);
    stickDriver(
      4.45 - 0.37 * Math.cos(s) - 0.39 * Math.sin(s),
      -0.37 * Math.sin(s) + 0.39 * Math.cos(s),
    );
    const cx = 2.65 + lug[0] * Math.cos(c) - lug[1] * Math.sin(c);
    const cy = lug[0] * Math.sin(c) + lug[1] * Math.cos(c);
    const dx = cx - dogAnchor[0],
      dy = cy - dogAnchor[1],
      d = Math.hypot(dx, dy);
    const along = (dogLength * dogLength - linkLength * linkLength + d * d) / (2 * d);
    const height = Math.sqrt(Math.max(0, dogLength * dogLength - along * along));
    const kx = dogAnchor[0] + (along * dx - height * dy) / d;
    const ky = dogAnchor[1] + (along * dy + height * dx) / d;
    rocker.rotation.z = Math.atan2(ky - dogAnchor[1], kx - dogAnchor[0]);
    link.position.set(kx, ky, 0);
    link.rotation.z = Math.atan2(cy - ky, cx - kx);
    curlDriver(kx, ky);
    sand.visible = load > 0.002;
    const fraction = clamp(load, 0, 1);
    sand.scale.set(0.48 + 0.52 * fraction, 0.04 + 0.96 * fraction, 0.57 + 0.43 * fraction);
    setTracks(travel, turn);
  }
  pose();
  return { root, pose, tip, bucket, actuators, rocker, link };
}
