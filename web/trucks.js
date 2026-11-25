import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { coloredGeometry } from './colored-geometry.js';

export const fleet = [
  {
    name: 'Cherry Picker',
    x: -0.35,
    z: -5.5,
    heading: 1,
    length: 3.15,
    width: 1.9,
    floor: 1.35,
    order: 0.85,
    paint: 0xa63c34,
  },
  {
    name: 'Mule Six',
    x: -5.3,
    z: 1.35,
    heading: -1,
    length: 3.75,
    width: 2.22,
    floor: 1.58,
    order: 1.25,
    paint: 0x237e76,
  },
];

export function addTruckBeds(core, w) {
  for (const t of fleet)
    core.world_add_truck(
      w,
      t.x,
      t.z,
      t.length / 2,
      t.width / 2,
      t.floor,
      Math.round(t.order * 64000),
      t.heading,
      Number(t === fleet[1]),
    );
}

function buildTruck(t, articulated) {
  const root = new T.Group(),
    sprung = new T.Group();
  root.position.set(t.x, 0, t.z);
  root.rotation.y = t.heading === 1 ? 0 : Math.PI;
  root.add(sprung);
  const surfaces = new Map(),
    shape = new T.Object3D();
  const graphite = 0x283031,
    rubber = 0x252522,
    steel = 0xb6b9ae,
    cream = 0xe4dcba,
    glass = 0x476d76,
    dark = 0x344443;
  function part(
    geo,
    x,
    y,
    z,
    color,
    sx = 1,
    sy = 1,
    sz = 1,
    rx = 0,
    ry = 0,
    rz = 0,
    parent = sprung,
  ) {
    shape.position.set(x, y, z);
    shape.rotation.set(rx, ry, rz);
    shape.scale.set(sx, sy, sz);
    shape.updateMatrix();
    if (!surfaces.has(parent)) surfaces.set(parent, []);
    surfaces.get(parent).push(coloredGeometry(geo, shape.matrix, color));
  }
  const box = new T.BoxGeometry(),
    cyl = new T.CylinderGeometry(1, 1, 1, 18);
  const b = (x, y, z, sx, sy, sz, color, rz = 0) => part(box, x, y, z, color, sx, sy, sz, 0, 0, rz);
  function profile(points, width, color) {
    const outline = new T.Shape(points.map(([x, y]) => new T.Vector2(x, y)));
    const g = new T.ExtrudeGeometry(outline, { depth: width, bevelEnabled: false });
    part(g, 0, 0, -width / 2, color);
    g.dispose();
  }
  const tube = (x, y, z, r, h, color) => part(cyl, x, y, z, color, r, h, r);
  const l = t.length / 2,
    w = t.width / 2,
    f = t.floor,
    cab = l + (articulated ? 1.36 : 0.85),
    hood = cab + 1.15;
  const tyre = articulated ? 0.65 : 0.51;
  b(0.98, 0.81, 0, t.length + 2.25, 0.26, 1.05, graphite);
  const axles = [];
  for (const axle of [-l + 0.51, l - 0.72, hood - 0.3]) {
    const hubs = [];
    for (const s of [-1, 1]) {
      const side = s * (w - 0.025);
      const wheels = new T.Group();
      wheels.position.set(axle, tyre, side);
      root.add(wheels);
      hubs.push(wheels);
      part(cyl, axle, tyre, side, rubber, tyre, 0.34, tyre, Math.PI / 2, 0, 0, wheels);
      part(
        cyl,
        axle,
        tyre,
        side + s * 0.18,
        articulated ? t.paint : steel,
        tyre * 0.6,
        0.075,
        tyre * 0.6,
        Math.PI / 2,
        0,
        0,
        wheels,
      );
      part(
        cyl,
        axle,
        tyre,
        side + s * 0.23,
        graphite,
        tyre * 0.3,
        0.09,
        tyre * 0.3,
        Math.PI / 2,
        0,
        0,
        wheels,
      );
      for (let n = 0; n < 7; n++) {
        const a = (n * Math.PI * 2) / 7;
        part(
          cyl,
          axle + Math.cos(a) * tyre * 0.43,
          tyre + Math.sin(a) * tyre * 0.43,
          side + s * 0.228,
          steel,
          0.035,
          0.035,
          0.035,
          Math.PI / 2,
          0,
          0,
          wheels,
        );
      }
      for (let n = 0; n < 22; n++) {
        const a = (n * Math.PI) / 11;
        part(
          box,
          axle + Math.cos(a) * tyre,
          tyre + Math.sin(a) * tyre,
          side,
          0x343430,
          0.051,
          0.115,
          0.335,
          0,
          0,
          a,
          wheels,
        );
      }
    }
    axles.push(hubs);
  }
  // A separate open, ribbed steel box with a tailgate, hinges and hoist subframe.
  const bedColor = articulated ? 0xd8ac44 : 0x949e99;
  b(0, f - 0.06, 0, t.length + 0.15, 0.12, t.width + 0.12, bedColor);
  for (const s of [-1, 1]) {
    if (articulated) {
      const outline = new T.Shape(
        [
          [-l - 0.05, f + 0.02],
          [-l - 0.38, f + 0.68],
          [-l - 0.38, f + 0.8],
          [l + 0.18, f + 0.89],
          [l + 0.06, f + 0.05],
        ].map(([x, y]) => new T.Vector2(x, y)),
      );
      const plate = new T.ExtrudeGeometry(outline, { depth: 0.085, bevelEnabled: false });
      part(plate, 0, 0, s * w - (s < 0 ? 0.085 : 0), bedColor);
      plate.dispose();
    } else b(0, f + 0.36, s * (w + 0.045), t.length + 0.16, 0.75, 0.09, bedColor);
    b(0, f + 0.74, s * (w + 0.055), t.length + 0.24, 0.105, 0.13, cream);
    b(0, f + 0.075, s * (w + 0.082), t.length + 0.21, 0.09, 0.13, dark);
    for (let j = 0; j < 6; j++)
      b(
        -l + 0.11 + ((t.length - 0.22) * j) / 5,
        f + 0.37,
        s * (w + 0.104),
        0.09,
        0.7,
        0.07,
        bedColor,
        -0.12,
      );
    b(-0.18, 0.98, s * 0.43, t.length - 0.15, 0.12, 0.12, t.paint, 0.1);
    b(-l - 0.13, f + 0.12, s * w * 0.79, 0.06, 0.115, 0.2, 0xbc4431);
  }
  b(-l - 0.05, f + 0.36, 0, 0.12, 0.73, t.width, bedColor);
  b(l + 0.05, f + 0.49, 0, 0.12, 1.0, t.width + 0.09, bedColor);
  for (const z of [-0.63, 0, 0.63]) b(-l - 0.127, f + 0.38, z, 0.055, 0.61, 0.07, steel);
  b(cab, 1.35, 0, 1.18, 0.83, 1.55, t.paint);
  profile(
    [
      [cab - 0.53, 1.7],
      [cab + 0.57, 1.7],
      [cab + 0.4, 2.31],
      [cab - 0.48, 2.31],
    ],
    1.46,
    glass,
  );
  b(cab, 2.34, 0, 1.3, 0.14, 1.67, articulated ? t.paint : cream);
  for (const s of [-1, 1]) {
    for (const x of [cab - 0.49, cab + 0.49]) b(x, 2.02, s * 0.74, 0.09, 0.65, 0.07, t.paint);
    b(cab, 1.76, s * 0.75, 1.11, 0.08, 0.055, t.paint);
    b(cab - 0.25, 1.58, s * 0.795, 0.16, 0.04, 0.033, graphite);
    b(cab + 0.37, 2.07, s * 0.87, 0.055, 0.05, 0.28, steel);
    b(cab + 0.37, 2.02, s * 1.02, 0.135, 0.23, 0.07, graphite);
    b(cab - 0.1, 0.87, s * 0.81, 1.0, 0.13, 0.36, steel);
    b(cab - 0.1, 1.06, s * 0.74, 0.83, 0.1, 0.25, graphite);
    if (!articulated) {
      tube(cab - 0.76, 2.04, s * 0.72, 0.097, 1.62, steel);
      tube(cab - 0.76, 1.64, s * 0.72, 0.14, 0.64, graphite);
      part(cyl, cab - 0.01, 2.48, s * 0.49, steel, 0.065, 0.52, 0.065, 0, 0, Math.PI / 2);
      part(cyl, cab - 0.42, 0.92, s * 0.7, steel, 0.17, 0.86, 0.17, 0, 0, Math.PI / 2);
    } else {
      b(cab + 0.07, 1.08, s, 1.72, 0.12, 0.36, t.paint);
      b(cab + 0.33, 1.48, s * 1.05, 0.92, 0.055, 0.05, cream);
      for (const x of [cab - 0.1, cab + 0.75]) b(x, 1.3, s * 1.05, 0.04, 0.43, 0.04, cream);
      b(l + 0.51, 1.03, s * 0.82, 0.14, 0.67, 0.14, graphite);
      b(l + 0.58, 0.87, s * 0.4, 0.9, 0.095, 0.095, steel, -0.16);
      b(l + 0.5, 1.05, s * 0.3, 0.52, 0.29, 0.23, graphite);
      b(cab - 0.66, 1.49, s * 0.85, 0.66, 0.1, 0.32, steel);
      for (let k = 0; k < 3; k++) b(cab - 0.45, 0.59 + k * 0.22, s * 0.94, 0.42, 0.055, 0.2, cream);
    }
    b(hood, 1.08, s * 0.81, 1.31, 0.16, 0.34, t.paint);
    b(hood + 0.52, 1.29, s * 0.69, 0.12, 0.18, 0.26, 0xffe2a4);
    b(cab + 0.36, 2.44, s * 0.55, 0.13, 0.09, 0.14, 0xffae35);
  }
  profile(
    [
      [hood - 0.64, 1.01],
      [hood + 0.64, 1.01],
      [hood + 0.64, articulated ? 1.39 : 1.57],
      [hood - 0.64, articulated ? 1.72 : 1.64],
    ],
    1.28,
    t.paint,
  );
  if (articulated) {
    b(cab - 0.1, 2.4, 0, 1.7, 0.08, 1.96, t.paint, -0.035);
    b(l + 0.22, 2.14, 0, 0.79, 0.12, 2.3, bedColor, -0.13);
    tube(cab - 0.62, 2.12, -0.55, 0.075, 0.72, graphite);
    for (let j = 0; j < 7; j++)
      b(hood - 0.27 + j * 0.105, 1.65 - j * 0.025, 0, 0.045, 0.035, 0.68, graphite);
  } else {
    for (const s of [-1, 1])
      for (let j = 0; j < 6; j++)
        b(hood - 0.46 + j * 0.115, 1.4, s * 0.647, 0.046, 0.14, 0.014, steel, -0.23);
    b(cab + 0.58, 2.28, 0, 0.28, 0.055, 1.64, cream, -0.13);
  }
  b(hood + 0.63, 1.3, 0, 0.09, 0.61, 1.1, steel);
  for (let n = 0; n < 11; n++) b(hood + 0.68, 1.3, (n - 5) * 0.088, 0.025, 0.51, 0.038, graphite);
  b(hood + 0.66, 0.91, 0, 0.21, 0.22, 1.83, articulated ? dark : steel);
  for (const s of [-1, 1])
    for (let k = 0; k < 3; k++) b(cab - 0.18 + k * 0.13, 1.5, s * 0.785, 0.07, 0.09, 0.016, cream);
  for (const [parent, list] of surfaces) {
    const geometry = mergeGeometries(list);
    for (const item of list) item.dispose();
    if (parent !== sprung) geometry.translate(-parent.position.x, -tyre, -parent.position.z);
    const mesh = new T.Mesh(
      geometry,
      new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.66, metalness: 0.19 }),
    );
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
  }
  box.dispose();
  cyl.dispose();
  const label = document.createElement('canvas');
  label.width = 512;
  label.height = 128;
  const ctx = label.getContext('2d');
  ctx.fillStyle = articulated ? '#e6bd51' : '#394a49';
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = articulated ? '#253735' : '#f8eacb';
  ctx.font = 'bold 61px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(articulated ? 'MULE   6×6' : 'CHERRY PICKER', 256, 64);
  const decal = new T.CanvasTexture(label);
  decal.colorSpace = T.SRGBColorSpace;
  const marking = new T.MeshStandardMaterial({ map: decal, roughness: 0.78 });
  for (const s of [-1, 1]) {
    const m = new T.Mesh(new T.PlaneGeometry(1.38, 0.34), marking);
    m.position.set(0, f + 0.38, s * (w + 0.145));
    m.rotation.y = s < 0 ? Math.PI : 0;
    sprung.add(m);
  }
  const soil = new T.PlaneGeometry(t.length - 0.02, t.width - 0.02, 10, 6);
  soil.rotateX(-Math.PI / 2);
  const load = new T.Mesh(soil, new T.MeshStandardMaterial({ color: 0xd5b17c, roughness: 1 }));
  load.position.y = f + 0.008;
  load.receiveShadow = true;
  sprung.add(load);
  const lamp = new T.Mesh(
    new T.SphereGeometry(0.098, 12, 8),
    new T.MeshBasicMaterial({ color: 0xe49c40 }),
  );
  lamp.position.set(cab, 2.48, 0);
  sprung.add(lamp);
  // Three live axle beams and six telescopic dampers share one instanced draw.
  const links = new T.InstancedMesh(
    new T.CylinderGeometry(1, 1, 1, 10),
    new T.MeshStandardMaterial({ color: 0x566061, metalness: 0.5, roughness: 0.55 }),
    15,
  );
  links.frustumCulled = false;
  links.castShadow = true;
  root.add(links);
  return { root, sprung, load, lamp, axles, links, tyre, prior: -1, lastPose: new Float32Array(9) };
}

export function createFleet(scene) {
  const group = new T.Group();
  scene.add(group);
  const trucks = fleet.map((t, i) => buildTruck(t, i === 1));
  for (const t of trucks) group.add(t.root);
  const start = new T.Vector3(),
    end = new T.Vector3(),
    up = new T.Vector3(0, 1, 0);
  const transform = new T.Object3D(),
    direction = new T.Vector3();
  function rod(mesh, slot, a, b, radius) {
    direction.subVectors(b, a);
    transform.scale.set(radius, direction.length(), radius);
    transform.quaternion.setFromUnitVectors(up, direction.normalize());
    transform.position.copy(a).lerp(b, 0.5);
    transform.updateMatrix();
    mesh.setMatrixAt(slot, transform.matrix);
  }
  return {
    group,
    reset() {
      trucks.forEach((t, i) => {
        t.prior = -1;
        t.lastPose.fill(Infinity);
        t.root.position.x = fleet[i].x;

        t.lamp.material.color.setHex(0xe49c40);
      });
    },
    tick(core, w) {
      let changed = false;
      trucks.forEach((truck, i) => {
        const mass = core.world_truck_load(w, i),
          t = fleet[i];
        const travel = core.world_truck_offset(w, i);
        if (truck.root.position.x !== t.x + travel) {
          truck.root.position.x = t.x + travel;
          for (const axle of truck.axles)
            for (const hub of axle) hub.rotation.z = (-travel * t.heading) / truck.tyre;
          changed = true;
        }
        if (truck.prior !== mass) {
          const bins = new Int32Array(core.memory.buffer, core.world_truck_bins(w, i), 15);
          const attr = truck.load.geometry.attributes.position;
          for (let n = 0; n < attr.count; n++) {
            const col = T.MathUtils.clamp(
              ((attr.getX(n) * t.heading) / t.length + 0.5) * 5 - 0.5,
              0,
              4,
            );
            const row = T.MathUtils.clamp(
              ((attr.getZ(n) * t.heading) / t.width + 0.5) * 3 - 0.5,
              0,
              2,
            );
            const x = Math.floor(col),
              z = Math.floor(row),
              u = col - x,
              v = row - z;
            const at = (dx, dz) => bins[Math.min(2, z + dz) * 5 + Math.min(4, x + dx)];
            attr.setY(
              n,
              (((1 - v) * ((1 - u) * at(0, 0) + u * at(1, 0)) +
                v * ((1 - u) * at(0, 1) + u * at(1, 1))) *
                15) /
                (64000 * t.width * t.length),
            );
          }
          attr.needsUpdate = true;
          truck.load.geometry.computeVertexNormals();
          truck.load.visible = mass > 0;

          truck.prior = mass;
          changed = true;
          if (mass >= t.order * 64000) truck.lamp.material.color.setHex(0x76ff92);
        }
        const pose = new Float32Array(core.memory.buffer, core.world_truck_pose(w, i), 9);
        if (truck.lastPose.some((v, j) => Math.abs(v - pose[j]) > 0.000025)) {
          const pitch = Math.atan(t.heading * pose[1]);
          truck.sprung.rotation.set(
            -Math.atan(t.heading * pose[2] * Math.cos(pitch)),
            0,
            pitch,
            'ZXY',
          );
          truck.sprung.position.set(0, -t.floor, 0).applyQuaternion(truck.sprung.quaternion);
          truck.sprung.position.y += t.floor + pose[0];
          truck.sprung.updateMatrix();
          for (let axle = 0; axle < 3; axle++) {
            const hubs = truck.axles[axle];
            for (let side = 0; side < 2; side++) {
              const hub = hubs[side].position;
              hub.y = pose[3 + 2 * axle + (t.heading > 0 ? side : 1 - side)];
              start
                .set(hub.x + 0.13, truck.tyre + 0.51, hub.z * 0.65)
                .applyMatrix4(truck.sprung.matrix);
              end.set(hub.x, hub.y, hub.z * 0.83);
              const slot = 3 + axle * 4 + side * 2;
              rod(truck.links, slot, start, end, 0.044);
              end.lerp(start, 0.43);
              rod(truck.links, slot + 1, start, end, 0.076);
            }
            const axleRoll = -Math.atan2(hubs[1].position.y - hubs[0].position.y, t.width - 0.05);
            for (const hub of hubs) hub.rotation.x = axleRoll;
            rod(truck.links, axle, hubs[0].position, hubs[1].position, 0.116);
          }
          truck.links.instanceMatrix.needsUpdate = true;
          truck.lastPose.set(pose);
          changed = true;
        }
      });
      return changed;
    },
  };
}
