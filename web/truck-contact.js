import { Euler, Quaternion, Vector3 } from 'three';
import { fleet } from './trucks.js';
import { machineDimensions as rig } from './machine.js';
import { forward } from './arm.js';

const v = () => new Vector3();
const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
const diff = v(),
  cross = v(),
  bestAxis = v(),
  worldPoint = v(),
  face = v();
const rot = new Quaternion(),
  upper = new Quaternion(),
  joint = new Quaternion(),
  euler = new Euler();
function box(x, y, z, hx, hy, hz) {
  return {
    local: new Vector3(x, y, z),
    half: [hx, hy, hz],
    c: v(),
    a: [v(), v(), v()],
    reach: Math.hypot(hx, hy, hz),
  };
}
function place(b, q, center) {
  b.c.copy(b.local).applyQuaternion(q).add(center);
  for (let i = 0; i < 3; i++) b.a[i].copy(axes[i]).applyQuaternion(q);
}
function radius(b, axis) {
  return (
    Math.abs(b.a[0].dot(axis)) * b.half[0] +
    Math.abs(b.a[1].dot(axis)) * b.half[1] +
    Math.abs(b.a[2].dot(axis)) * b.half[2]
  );
}
// Signed separating-axis distance. A positive axis separates the two solids.
// Keep the least penetrating axis and its direction for the chassis impulse.
function separation(a, b, margin) {
  diff.subVectors(a.c, b.c);
  if (diff.lengthSq() > (a.reach + b.reach + margin) ** 2) return Infinity;
  let best = -Infinity;
  function test(dir) {
    const d = diff.dot(dir),
      gap = Math.abs(d) - radius(a, dir) - radius(b, dir);
    if (gap > best) {
      best = gap;
      bestAxis.copy(dir).multiplyScalar(d < 0 ? -1 : 1);
    }
    return gap > margin;
  }
  for (let i = 0; i < 3; i++) if (test(a.a[i]) || test(b.a[i])) return Infinity;
  for (const aa of a.a)
    for (const bb of b.a) {
      cross.crossVectors(aa, bb);
      const n = cross.lengthSq();
      if (n > 1e-8 && test(cross.multiplyScalar(1 / Math.sqrt(n)))) return Infinity;
    }
  return best;
}
const carrier = [
  box(0, 0.49, -1.09, 1.79, 0.46, 0.3),
  box(0, 0.49, 1.09, 1.79, 0.46, 0.3),
  ...[-1, 1].flatMap((end) =>
    [-1, 1].map((side) => box(end * 1.86, 0.49, side * 1.09, 0.22, 0.31, 0.3)),
  ),
  box(-0.2, 1.29, 0, 1.57, 0.17, 1.3),
  box(-1.87, 1.7, 0, 0.3, 0.54, 0.91),
  box(-0.56, 1.78, -0.05, 1.26, 0.42, 1.2),
  box(0.37, 2.34, 0.83, 0.88, 0.83, 0.51),
  box(0, 0, 0, rig.boom * 0.255, 0.25, 0.26),
  box(0, 0, 0, rig.boom * 0.255, 0.26, 0.26),
  box(0, 0, 0, rig.stick * 0.5, 0.2, 0.21),
  box(0, 0, 0, 0.52, 0.42, 0.59),
];
function placeCarrier(p, position, rotation) {
  for (let i = 0; i < 6; i++) place(carrier[i], rotation, position);
  upper.copy(rotation).multiply(rot.setFromAxisAngle(axes[1], p.yaw));
  for (let i = 6; i < 10; i++) place(carrier[i], upper, position);
  const [sx, sy] = rig.shoulder,
    k = forward(p),
    mid = p.boom + p.stick;
  const ex = sx + rig.boom * Math.cos(p.boom),
    ey = sy + rig.boom * Math.sin(p.boom);
  function link(i, x, y, angle, offset, lift) {
    // Mesh centre relative to the mechanical pin, expressed in house coordinates.
    const c = Math.cos(angle),
      s = Math.sin(angle);
    face
      .set(x + offset * c - lift * s, y + offset * s + lift * c, 0)
      .applyQuaternion(upper)
      .add(position);
    joint.copy(upper).multiply(rot.setFromAxisAngle(axes[2], angle));
    place(carrier[i], joint, face);
  }
  link(10, sx, sy, p.boom, rig.boom * 0.25, 0.26);
  link(11, sx, sy, p.boom, rig.boom * 0.75, 0.25);
  link(12, ex, ey, mid, rig.stick * 0.5, 0);
  link(13, k.wristX, k.wristY, -k.pitch, -0.4, -0.38);
}
const vehicles = fleet.map((t, i) => {
  const l = t.length / 2,
    w = t.width / 2,
    f = t.floor,
    cab = l + (i ? 1.36 : 0.85),
    hood = cab + 1.15;
  const solids = [
    box(0.98, 0.82, 0, l + 1.12, 0.18, 0.57),
    box(0, f - 0.075, 0, l + 0.08, 0.085, w + 0.1),
    box(0, f + 0.37, -w, l + 0.08, 0.39, 0.105),
    box(0, f + 0.37, w, l + 0.08, 0.39, 0.105),
    box(-l, f + 0.37, 0, 0.1, 0.39, w + 0.08),
    box(l, f + 0.37, 0, 0.1, 0.39, w + 0.08),
    box(cab, 1.39, 0, 0.7, 1.06, 0.89),
    box(hood, 1.01, 0, 0.77, 0.69, 0.88),
    box(hood + 0.53, 0.8, 0, 0.21, 0.2, 0.96),
  ];
  for (const x of [-l + 0.51, l - 0.72, hood - 0.3])
    for (const s of [-1, 1]) {
      const r = i ? 0.65 : 0.51;
      solids.push(box(x, r, s * (w - 0.025), r * 0.84, r * 0.89, 0.2));
    }
  return {
    solids,
    wheelStart: solids.length - 6,
    q: new Quaternion(),
    origin: v(),
    contact: new Float64Array(4),
    offset: 0,
    speed: 0,
  };
});

let revision = 0;
export const truckRevision = () => revision;
export function positionTruckWalls(core, w) {
  revision++;
  vehicles.forEach((body, i) => {
    const t = fleet[i],
      pose = new Float32Array(core.memory.buffer, core.world_truck_pose(w, i), 9);
    const pitch = Math.atan(t.heading * pose[1]);
    body.q
      .setFromAxisAngle(axes[1], t.heading < 0 ? Math.PI : 0)
      .multiply(
        rot.setFromEuler(
          euler.set(-Math.atan(t.heading * pose[2] * Math.cos(pitch)), 0, pitch, 'ZXY'),
        ),
      );
    const offset = core.world_truck_offset(w, i);
    body.speed = Math.min(1.8, Math.abs(offset - body.offset) * 60);
    body.offset = offset;
    body.origin.set(0, -t.floor, 0).applyQuaternion(body.q);
    body.origin.x += t.x + body.offset;
    body.origin.y += t.floor + pose[0];
    body.origin.z += t.z;
    for (let n = 0; n < body.wheelStart; n++) place(body.solids[n], body.q, body.origin);
    for (let n = 0; n < 6; n++) {
      const axle = n >> 1,
        side = n % 2,
        start = 3 + 2 * axle;
      const axleRoll = -Math.atan2(t.heading * (pose[start + 1] - pose[start]), t.width - 0.05);
      joint
        .setFromAxisAngle(axes[1], t.heading < 0 ? Math.PI : 0)
        .multiply(rot.setFromAxisAngle(axes[0], axleRoll));
      const wheel = body.solids[body.wheelStart + n];
      for (let k = 0; k < 3; k++) wheel.a[k].copy(axes[k]).applyQuaternion(joint);
      wheel.c.set(
        t.x + offset + t.heading * wheel.local.x,
        pose[start + (t.heading > 0 ? side : 1 - side)],
        t.z + t.heading * wheel.local.z,
      );
    }
  });
}

// Report one contact manifold point per excavator hull. Centre the point on
// tangential face overlap so a long bed does not exert torque at a remote end.
export function truckHulls(p, position, rotation, report, margin = 0.025) {
  placeCarrier(p, position, rotation);
  let distance = Infinity;
  for (let j = 0; j < carrier.length; j++) {
    const a = carrier[j];
    let nearest = Infinity,
      owner = -1;
    for (let i = 0; i < vehicles.length; i++) {
      const body = vehicles[i];
      if (
        Math.abs(a.c.z - body.origin.z) > a.reach + 2.2 ||
        Math.abs(a.c.x - body.origin.x) > a.reach + 6.5
      )
        continue;
      for (const b of body.solids) {
        const d = separation(a, b, margin);
        if (d >= nearest) continue;
        nearest = d;
        owner = i;
        if (report) {
          normal.copy(bestAxis);
          diff.subVectors(a.c, b.c);
          worldPoint.copy(b.c);
          for (let k = 0; k < 3; k++)
            worldPoint.addScaledVector(
              b.a[k],
              Math.max(-b.half[k], Math.min(b.half[k], diff.dot(b.a[k]))),
            );
          diff.subVectors(worldPoint, a.c);
          worldPoint.copy(a.c);
          for (let k = 0; k < 3; k++) {
            const dot = a.a[k].dot(normal);
            const offset =
              Math.abs(dot) > 0.98
                ? -Math.sign(dot) * a.half[k]
                : Math.max(-a.half[k], Math.min(a.half[k], diff.dot(a.a[k])));
            worldPoint.addScaledVector(a.a[k], offset);
          }
        }
      }
    }
    if (owner >= 0 && report) report(j, nearest, worldPoint, normal, owner);
    distance = Math.min(nearest, distance);
  }
  return distance;
}
const normal = v();
export function clearTruckReactions() {
  for (const t of vehicles) t.contact.fill(0);
}
export function reactTruck(i, point, n, load) {
  const t = vehicles[i],
    down = Math.max(0, n.y) * load * 0.5;
  t.contact[0] += down;
  t.contact[1] += down * (point.x - fleet[i].x - t.offset);
  t.contact[2] += down * (point.z - fleet[i].z);
  if (n.x * fleet[i].heading > 0.2) t.contact[3] = 1;
}
export function truckInputs(i) {
  return vehicles[i].contact;
}

// Test the current swept path before releasing the parking brake or feeding
// throttle. The stopping distance includes one fixed update of driver latency.
export function checkDispatchLane(p, position, rotation, i) {
  placeCarrier(p, position, rotation);
  const body = vehicles[i],
    t = fleet[i];
  const ahead = 0.12 + body.speed / 60 + (body.speed * body.speed) / (2 * 2.4);
  for (const a of carrier)
    for (const b of body.solids) {
      const gap = separation(a, b, ahead + 0.08);
      if (gap === Infinity || gap > ahead + 0.03) continue;
      b.c.x += t.heading * ahead;
      const future = separation(a, b, 0.05);
      b.c.x -= t.heading * ahead;
      if (future < 0.035 && future < gap - 0.01) {
        body.contact[3] = 1;
        return;
      }
    }
}
