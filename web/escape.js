import * as T from 'three';

export const escapeYard = {
  lip: 5.25,
  far: 15.5,
  roadEnd: 23.3,
  gateX: 11.8,
  halfWidth: 2.55,
  height: 0.72,
  bevelRun: 0.5,
  bevelRise: 0.32,
  bank: { x: 2.85, z: -4.45 },
};
export function newEscapeWorld(core, dense) {
  const { lip, far, halfWidth, height, bank } = escapeYard;
  return core.escape_new(
    dense,
    lip,
    far,
    halfWidth,
    Math.round(height * 1000),
    bank.x,
    bank.z,
    escapeYard.bevelRun,
    escapeYard.bevelRise,
  );
}
export function deckTop(x) {
  const d = escapeYard;
  return d.height - d.bevelRise * Math.max(0, 1 - Math.max(0, x - d.lip) / d.bevelRun);
}
export function onDeck(x, z) {
  return x >= escapeYard.lip && x <= escapeYard.far && Math.abs(z) <= escapeYard.halfWidth;
}
export function parkOnDeck(body) {
  let left = false,
    right = false;
  for (const p of body.patches) {
    if (
      !onDeck(p.world.x, p.world.z) ||
      p.world.x < escapeYard.lip + escapeYard.bevelRun ||
      p.world.y < escapeYard.height - 0.09
    )
      return false;
    if (p.normalLoad > 1 && p.n.axis.y > 0.8) {
      if (p.side < 0) left = true;
      else right = true;
    }
  }
  return left && right;
}
export function createExit(scene) {
  const group = new T.Group();
  scene.add(group);
  const { lip, far, halfWidth: w, height: h } = escapeYard;
  const mat = (color) => new T.MeshStandardMaterial({ color, roughness: 0.87 });
  const concrete = mat(0xacac9b),
    edge = mat(0x676e65),
    white = mat(0xf4e7c6);
  const green = mat(0x177160),
    dark = mat(0x263532),
    brass = mat(0xffb43d);
  const cube = new T.BoxGeometry(),
    v = new T.Vector3(),
    q = new T.Quaternion(),
    up = new T.Vector3(0, 1, 0);
  // Batch fixed markings, retaining blocks, poles and feet by finish.
  const pieces = new Map();
  function box(x, y, z, sx, sy, sz, m, ry = 0) {
    if (!pieces.has(m)) pieces.set(m, []);
    pieces
      .get(m)
      .push(
        new T.Matrix4().compose(
          new T.Vector3(x, y, z),
          q.setFromAxisAngle(up, ry),
          v.set(sx, sy, sz),
        ),
      );
  }
  const run = escapeYard.bevelRun,
    rise = escapeYard.bevelRise,
    nose = h - rise;
  const section = new T.Shape();
  section.moveTo(lip, 0);
  section.lineTo(far, 0);
  section.lineTo(far, h);
  section.lineTo(lip + run, h);
  section.lineTo(lip, nose);
  section.closePath();
  const slab = new T.Mesh(
    new T.ExtrudeGeometry(section, { depth: w * 2, bevelEnabled: false }),
    concrete,
  );
  slab.position.z = -w;
  slab.castShadow = slab.receiveShadow = true;
  group.add(slab);
  for (let i = 0; i < 6; i++) {
    const z = -w + ((2 * i + 1) * w) / 6;
    box(lip - 0.014, nose * 0.48, z, 0.026, nose * 0.89, w / 3 - 0.035, edge);
    for (let j = 1; j <= 4; j++)
      box(lip - 0.03, (nose * j) / 5, z, 0.018, 0.024, 0.23, j === 4 ? brass : white);
  }
  for (const side of [-1, 1]) {
    box(
      (lip + run + far) / 2,
      h + 0.008,
      side * (w - 0.19),
      far - lip - run - 0.26,
      0.016,
      0.08,
      white,
    );
    const x = lip + run + 0.12,
      z = side * (w - 0.11);
    box(x, h + 0.07, z, 0.32, 0.14, 0.32, dark);
    box(x, h + 1.03, z, 0.06, 2.0, 0.06, dark);
    box(x, h + 1.92, z, 0.074, 0.24, 0.074, brass);
    const shape = new T.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(0.81, -0.05);
    shape.lineTo(0.64, -0.27);
    shape.lineTo(0.84, -0.49);
    shape.lineTo(0, -0.44);
    shape.closePath();
    const fabric = new T.ShapeGeometry(shape);
    const flag = new T.Mesh(
      fabric,
      new T.MeshStandardMaterial({ color: 0x167858, side: T.DoubleSide }),
    );
    flag.position.set(x, h + 1.84, z);
    group.add(flag);
    const emblem = new T.Mesh(
      new T.PlaneGeometry(0.19, 0.14),
      new T.MeshBasicMaterial({ color: 0xfff0c0, side: T.DoubleSide }),
    );
    emblem.position.set(x + 0.28, h + 1.61, z + 0.005);
    group.add(emblem);
  }
  for (const x of [lip + 1.15, lip + 2.4, lip + 3.65]) {
    for (const s of [-1, 1]) box(x, h + 0.012, s * 0.255, 0.77, 0.022, 0.105, white, s * 0.72);
  }
  // A readable destination from the driver's side and in the opening camera.
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 176;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#184b3b';
  ctx.fillRect(0, 0, 512, 176);
  ctx.strokeStyle = '#eeeaca';
  ctx.lineWidth = 6;
  ctx.strokeRect(9, 9, 494, 158);
  ctx.fillStyle = '#fff4ce';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 112px Arial';
  ctx.fillText('EXIT', 256, 92);
  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace;
  const sign = new T.Mesh(
    new T.PlaneGeometry(1.79, 0.62),
    new T.MeshStandardMaterial({ map: tex, roughness: 0.85 }),
  );
  const gateX = escapeYard.gateX;
  sign.position.set(gateX, h + 1.68, -w + 0.18);
  sign.rotation.y = -0.58;
  group.add(sign);
  const reverseSign = sign.clone();
  reverseSign.rotateY(Math.PI);
  reverseSign.translateZ(0.018);
  group.add(reverseSign);
  box(gateX, h + 0.72, -w + 0.18, 0.28, 1.44, 0.28, dark);
  box(gateX, h + 0.24, w - 0.17, 0.2, 0.48, 0.2, edge);
  const barrier = new T.Group();
  barrier.position.set(gateX, h + 0.81, -w + 0.18);
  group.add(barrier);
  const bar = new T.Mesh(cube, white);
  const plank = new T.Group();
  plank.position.z = w - 0.18;
  barrier.add(plank);
  bar.scale.set(0.13, 0.16, w * 2 - 0.36);
  bar.castShadow = true;
  plank.add(bar);
  const stripes = new T.InstancedMesh(cube, mat(0xa44127), 6);
  for (let i = 0; i < 6; i++)
    stripes.setMatrixAt(
      i,
      new T.Matrix4().makeScale(0.145, 0.166, 0.34).setPosition(0, 0, 0.32 + i * 0.78 - (w - 0.18)),
    );
  plank.add(stripes);
  const lampMat = new T.MeshBasicMaterial({ color: 0xffa333 });
  const lamp = new T.Mesh(new T.SphereGeometry(0.1, 10, 7), lampMat);
  lamp.position.set(gateX - 0.16, h + 1.2, -w + 0.18);
  group.add(lamp);
  // The service road carries the apron past the playable boundary.
  box(far + 3.9, h - 0.14, 0, 7.81, 0.27, w * 2 - 0.06, edge);
  for (const z of [-w + 0.24, w - 0.24]) box(far + 3.9, h + 0.002, z, 7.8, 0.014, 0.07, white);
  for (const [material, transforms] of pieces) {
    const mesh = new T.InstancedMesh(cube, material, transforms.length);
    transforms.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  let openness = 0;
  // Survey crosses stay at the crawler's last failed contact while it backs away.
  const crosses = [-1, 1].map(() => {
    const mark = new T.Group();
    for (const angle of [-Math.PI / 4, Math.PI / 4]) {
      const stripe = new T.Mesh(cube, new T.MeshBasicMaterial({ color: 0xf65e2b }));
      stripe.scale.set(0.8, 0.028, 0.1);
      stripe.rotation.y = angle;
      mark.add(stripe);
    }
    mark.visible = false;
    group.add(mark);
    return mark;
  });
  return {
    group,
    plank,
    markStall(body, ground) {
      const samples = [-1, 1].map((side) => {
        let front = null;
        for (const pad of body.patches)
          if (pad.side === side && (!front || pad.world.x > front.world.x)) front = pad;
        const x = Math.min(lip - 0.35, front.world.x),
          z = front.world.z;
        return { x, z, height: ground(x, z) };
      });
      for (let i = 0; i < 2; i++) {
        const { x, z, height } = samples[i];
        crosses[i].visible = height < samples[1 - i].height + 0.12;
        crosses[i].position.set(x, height + 0.045, z);
      }
      return crosses.every((c) => c.visible) ? 'both' : crosses[0].visible ? 'left' : 'right';
    },
    refreshMarks(ground) {
      for (const mark of crosses)
        if (mark.visible) mark.position.y = ground(mark.position.x, mark.position.z) + 0.045;
    },
    clearMarks() {
      for (const mark of crosses) mark.visible = false;
    },
    reset() {
      this.clearMarks();
      openness = 0;
      barrier.add(plank);
      plank.position.set(0, 0, w - 0.18);
      plank.quaternion.identity();
      plank.visible = true;
      barrier.rotation.x = 0;
      lampMat.color.setHex(0xffa333);
    },
    open(dt) {
      if (openness >= 1) return false;
      openness = Math.min(1, openness + dt * 0.77);
      barrier.rotation.x = -1.47 * (openness * openness * (3 - 2 * openness));
      lampMat.color.setHex(0x73f0ab);
      return true;
    },
  };
}
