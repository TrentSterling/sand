import assert from 'node:assert/strict';
import * as THREE from 'three';
import { carrierClearance, createMachine, machineDimensions as spec } from '../web/machine.js';

const rig = createMachine(THREE);
const actual = new THREE.Vector3(),
  expected = new THREE.Vector3(),
  edge = new THREE.Vector3();
const rotation = new THREE.Quaternion();
const [toothX, toothY] = spec.tooth;
let maxToothError = 0,
  maxLinkError = 0,
  maxRodPinError = 0,
  poses = 0;
const wrist = rig.root.getObjectByName('Stick pin'),
  mainBoom = rig.root.getObjectByName('Boom pin');
const envelope = {
  minReach: Infinity,
  maxReach: -Infinity,
  minHeight: Infinity,
  maxHeight: -Infinity,
};
const cylinders = rig.actuators.map(({ name }) => ({ name, min: Infinity, max: 0 }));
function interval([low, high], n) {
  return Array.from({ length: n }, (_, i) => low + ((high - low) * i) / (n - 1));
}
for (const boom of interval(spec.limits.boom, 9)) {
  for (const stick of interval(spec.limits.stick, 11)) {
    for (const curl of interval(spec.limits.curl, 15)) {
      const yaw = ((poses % 21) * Math.PI) / 10;
      const [px, py] = spec.shoulder;
      const pitch = boom + stick + spec.mountAngle - curl;
      const reach =
        px +
        spec.boom * Math.cos(boom) +
        spec.stick * Math.cos(boom + stick) +
        toothX * Math.cos(pitch) -
        toothY * Math.sin(pitch);
      const height =
        py +
        spec.boom * Math.sin(boom) +
        spec.stick * Math.sin(boom + stick) +
        toothX * Math.sin(pitch) +
        toothY * Math.cos(pitch);
      envelope.minHeight = Math.min(envelope.minHeight, height);
      envelope.maxHeight = Math.max(envelope.maxHeight, height);
      envelope.minReach = Math.min(envelope.minReach, reach);
      envelope.maxReach = Math.max(envelope.maxReach, reach);
      rig.pose({ boom, stick, curl, yaw, load: 0.5 });
      rig.root.updateMatrixWorld(true);
      expected.set(reach * Math.cos(yaw), height, -reach * Math.sin(yaw));
      maxToothError = Math.max(
        maxToothError,
        rig.tip.getWorldPosition(actual).distanceTo(expected),
      );
      for (const [local, part, other, length] of [
        [[0, 0, 0], rig.link, rig.rocker, 0.7],
        [[0.375, -0.126, 0], rig.bucket, rig.link, 0.59],
      ]) {
        actual.set(...local);
        part.localToWorld(actual);
        other.getWorldPosition(expected);
        other.getWorldQuaternion(rotation);
        edge.set(length, 0, 0).applyQuaternion(rotation).add(expected);
        maxLinkError = Math.max(maxLinkError, edge.distanceTo(actual));
      }
      for (const [i, { name, extension, barrelLength }] of rig.actuators.entries()) {
        assert(
          extension > 0.04 && extension < barrelLength - 0.08,
          name + ' exceeds usable stroke',
        );
        cylinders[i].min = Math.min(cylinders[i].min, extension);
        cylinders[i].max = Math.max(cylinders[i].max, extension);
        // Compare the actual visible end of each instanced rod to its moving eye.
        const mount = [mainBoom, mainBoom, wrist, rig.rocker][i];
        const local = [
          [1.7, 0.34, -0.36],
          [1.7, 0.34, 0.36],
          [-0.48, 0.25, 0],
          [0.7, 0, 0],
        ][i];
        mount.localToWorld(expected.set(...local));
        rig.actuators[i].rod.localToWorld(actual.set(1, 0, 0));
        maxRodPinError = Math.max(maxRodPinError, actual.distanceTo(expected));
      }
      poses++;
    }
  }
}
assert(maxToothError < 1e-10, 'Cutting edge diverged from solver transform');
assert(maxLinkError < 1e-10, 'Four-bar link detached');
assert(maxRodPinError < 1e-10, 'Cylinder rod separated from a moving eye');
rig.pose({ boom: 999, stick: -999, curl: 999 });
assert.equal(rig.root.getObjectByName('Boom pin').rotation.z, spec.limits.boom[1]);
assert.equal(rig.root.getObjectByName('Stick pin').rotation.z, spec.limits.stick[0]);
assert.equal(rig.bucket.rotation.z, spec.mountAngle - spec.limits.curl[1]);

// Test the actual five fabricated teeth. The game marker sits on the middle
// tooth's leading face with the heel and wear strip behind that plane.
const toothMesh = rig.teeth.children[0],
  pos = toothMesh.geometry.attributes.position;
const point = new THREE.Vector3(...spec.tooth, 0),
  tri = new THREE.Triangle();
let lowestX = Infinity,
  distanceToTooth = Infinity;
for (let i = 0; i < pos.count; i += 3) {
  tri.setFromAttributeAndIndices(pos, i, i + 1, i + 2);
  lowestX = Math.min(lowestX, tri.a.x, tri.b.x, tri.c.x);
  distanceToTooth = Math.min(
    distanceToTooth,
    tri.closestPointToPoint(point, actual).distanceTo(point),
  );
}
assert(
  Math.abs(lowestX - spec.tooth[0]) < 1e-6 && distanceToTooth < 1e-6,
  'Marker is off the cutting face',
);
assert(lowestX < -0.8 && rig.tip.position.x < 0, 'Bucket points out of the inward cut');

// Under virtual work, d(cylinder travel)/d(joint angle) is the effective
// torque arm. Finite differences check its sign and distance from a toggle
// through the stroke, including the end intervals.
const driveSweeps = [];
for (const [joint, index, sign] of [
  ['boom', 0, 1],
  ['stick', 2, -1],
  ['curl', 3, 1],
]) {
  let previous,
    smallest = Infinity,
    largest = 0;
  const stops = spec.limits[joint];
  const samples = interval(stops, 2049);
  for (const x of samples) {
    rig.pose({ [joint]: x });
    const travel = rig.actuators[index].distance;
    if (previous !== undefined) {
      const lever = (sign * (travel - previous)) / ((stops[1] - stops[0]) / (samples.length - 1));
      smallest = Math.min(smallest, lever);
      largest = Math.max(largest, lever);
    }
    previous = travel;
  }
  assert(smallest > 0.09 && largest < 0.9, joint + ' hit a dead centre or reversed direction');
  driveSweeps.push({
    joint,
    intervals: samples.length - 1,
    minMetresPerRadian: smallest,
    maxMetresPerRadian: largest,
  });
}

// These parts are extruded perpendicular to the working plane. Check the
// actual authored outlines and axial lanes, with conservative bevel padding.
function worldOutline(section) {
  const m = section.part.matrixWorld.elements;
  return section.outline.map(([x, y]) => [
    m[0] * x + m[4] * y + m[12],
    m[1] * x + m[5] * y + m[13],
  ]);
}
function distanceToSegment([x, y], [a, b], [c, d]) {
  const dx = c - a,
    dy = d - b;
  const t = Math.min(1, Math.max(0, ((x - a) * dx + (y - b) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - a - t * dx, y - b - t * dy);
}
function inside([x, y], poly) {
  let yes = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[i],
      [bx, by] = poly[j];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) yes = !yes;
  }
  return yes;
}
function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
function separation(a, b) {
  if (inside(a[0], b) || inside(b[0], a)) return 0;
  let gap = Infinity;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) {
      const p = a[i],
        q = a[(i + 1) % a.length],
        r = b[j],
        s = b[(j + 1) % b.length];
      if (cross(p, q, r) * cross(p, q, s) < 0 && cross(r, s, p) * cross(r, s, q) < 0) return 0;
      gap = Math.min(
        gap,
        distanceToSegment(p, r, s),
        distanceToSegment(q, r, s),
        distanceToSegment(r, p, q),
        distanceToSegment(s, p, q),
      );
    }
  return gap;
}
const clearanceSweeps = [];
for (const [joint, a, b] of [
  ['stick', 'boom web', 'stick web'],
  ['stick', 'boom clevis', 'stick web'],
  ['curl', 'stick web', 'bucket hanger'],
  ['curl', 'stick web', 'rolled bowl'],
  ['curl', 'rocker strap', 'bucket hanger'],
  ['curl', 'rocker strap', 'coupler link'],
  ['curl', 'coupler link', 'bucket hanger'],
]) {
  const sections = (name) => rig.steelSections.filter((s) => s.name === name);
  const pairs = sections(a).flatMap((p) => sections(b).map((q) => [p, q]));
  assert(pairs.length, a + ' / ' + b + ' missing sections');
  let minimum = Infinity;
  for (const x of interval(spec.limits[joint], 257)) {
    rig.pose({ [joint]: x });
    rig.root.updateMatrixWorld(true);
    for (const [p, q] of pairs) {
      const zGap = Math.max(0, Math.abs(p.z - q.z) - (p.width + q.width) * 0.5 - p.bevel - q.bevel);
      if (zGap >= minimum) continue;
      const xy = Math.max(
        0,
        separation(worldOutline(p), worldOutline(q)) - 1.5 * (p.bevel + q.bevel),
      );
      minimum = Math.min(minimum, Math.hypot(zGap, xy));
    }
  }
  assert(minimum > 0.003, a + ' clips ' + b + ' (gap ' + minimum + ')');
  clearanceSweeps.push({ a, b, poses: 257, minMetres: minimum });
}

// Reproduce the real folded tooth entering the right shoe lane. At the same
// joint angles a forward-facing house fits between the two tracks.
const contactPose = { boom: -0.16625, stick: -2.55, curl: -0.29113, yaw: Math.PI / 4 };
rig.pose(contactPose);
rig.root.updateMatrixWorld(true);
rig.tip.getWorldPosition(actual);
assert(
  Math.abs(actual.x) < 1.62 &&
    Math.abs(actual.z + 1.09) < 0.34 &&
    actual.y > 0.25 &&
    actual.y < 0.5,
);
const carrierContacts = {
  hit: carrierClearance(contactPose),
  centred: carrierClearance({ ...contactPose, yaw: 0 }),
  dig: carrierClearance({ boom: 0.37, stick: -1.3, curl: 0.27 }),
  carry: carrierClearance({ boom: 0.72, stick: -1.55, curl: 0.97 }),
};
assert(carrierContacts.hit < -0.1 && carrierContacts.centred > 0.04);
assert(carrierContacts.dig > 1 && carrierContacts.carry > 1);
let previous = carrierContacts.centred,
  min = Math.min(previous, carrierContacts.hit),
  maxStep = 0;
for (const yaw of interval([0, Math.PI * 2], 1025)) {
  const value = carrierClearance({ ...contactPose, yaw });
  assert(Number.isFinite(value));
  maxStep = Math.max(maxStep, Math.abs(previous - value));
  min = Math.min(min, value);
  previous = value;
}
assert(maxStep < 0.035 && Math.abs(previous - carrierContacts.centred) < 1e-7);
Object.assign(carrierContacts, { min, maxStep });
const fill = rig.root.getObjectByName('Retained bucket load');
const loadGeometry = fill.geometry,
  loadVertices = loadGeometry.attributes.position;
let largestVolumeError = 0;
const halfCentroids = [];
for (const pitch of [-0.9, 0.75])
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    rig.pose({ boom: 0.4, stick: -1.2, curl: pitch + 0.4, load: fraction });
    let volume = 0,
      moment = 0;
    for (let k = 0; k < loadGeometry.index.count; k += 3) {
      const ids = [0, 1, 2].map((j) => loadGeometry.index.getX(k + j));
      const [a, b, c] = ids;
      const area =
        Math.abs(
          (loadVertices.getX(b) - loadVertices.getX(a)) *
            (loadVertices.getZ(c) - loadVertices.getZ(a)) -
            (loadVertices.getX(c) - loadVertices.getX(a)) *
              (loadVertices.getZ(b) - loadVertices.getZ(a)),
        ) * 0.5;
      for (const i of ids) {
        fill.getVertexPosition(i, actual);
        const dv = (area * (actual.y - loadVertices.getY(i))) / 3;
        assert(dv >= -1e-9, 'Load material inverted through the interior');
        volume += dv;
        moment += actual.x * dv;
      }
    }
    largestVolumeError = Math.max(largestVolumeError, Math.abs(volume - 0.55 * fraction));
    if (fraction === 0.5) halfCentroids.push(moment / volume);
  }
assert(largestVolumeError < 1e-6 && halfCentroids[1] - halfCentroids[0] > 0.05);
const massCalibration = { ...fill.userData.capacity, largestVolumeError, halfCentroids };
let meshCount = 0,
  triangles = 0;
rig.root.traverse((part) => {
  if (!part.isMesh) return;
  meshCount++;
  const attr = part.geometry.attributes.position;
  for (const x of attr.array) assert(Number.isFinite(x));
  triangles +=
    ((part.geometry.index?.count ?? attr.count) * (part.isInstancedMesh ? part.count : 1)) / 3;
});
console.log(
  JSON.stringify(
    {
      poses,
      maxToothError,
      distanceToTooth,
      maxLinkError,
      maxRodPinError,
      meshCount,
      triangles,
      envelope,
      cylinders,
      driveSweeps,
      clearanceSweeps,
      carrierContacts,
      massCalibration,
    },
    null,
    2,
  ),
);
