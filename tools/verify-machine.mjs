import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createMachine, machineDimensions as spec } from '../web/machine.js';

const rig = createMachine(THREE);
const actual = new THREE.Vector3(),
  expected = new THREE.Vector3(),
  edge = new THREE.Vector3();
const rotation = new THREE.Quaternion();
const [toothX, toothY] = spec.tooth;
let maxToothError = 0,
  maxLinkError = 0,
  poses = 0;
const cylinders = rig.actuators.map(({ name }) => ({ name, min: Infinity, max: 0 }));
function interval([low, high], n) {
  return Array.from({ length: n }, (_, i) => low + ((high - low) * i) / (n - 1));
}
for (const boom of interval(spec.limits.boom, 9)) {
  for (const stick of interval(spec.limits.stick, 11)) {
    for (const curl of interval(spec.limits.curl, 15)) {
      const yaw = ((poses % 21) * Math.PI) / 10;
      const [px, py] = spec.shoulder;
      const pitch = boom + stick + curl;
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
      rig.pose({ boom, stick, curl, yaw, load: 0.5 });
      rig.root.updateMatrixWorld(true);
      expected.set(reach * Math.cos(yaw), height, -reach * Math.sin(yaw));
      maxToothError = Math.max(
        maxToothError,
        rig.tip.getWorldPosition(actual).distanceTo(expected),
      );
      for (const [local, part, other, length] of [
        [[0, 0, 0], rig.link, rig.rocker, 0.54],
        [[-0.29, 0.22, 0], rig.bucket, rig.link, 0.59],
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
      }
      poses++;
    }
  }
}
assert(maxToothError < 1e-10, 'Cutting edge diverged from solver transform');
assert(maxLinkError < 1e-10, 'Four-bar link detached');
rig.pose({ boom: 999, stick: -999, curl: 999 });
assert.equal(rig.root.getObjectByName('Boom pin').rotation.z, spec.limits.boom[1]);
assert.equal(rig.root.getObjectByName('Stick pin').rotation.z, spec.limits.stick[0]);
assert.equal(rig.bucket.rotation.z, spec.limits.curl[1]);
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
  JSON.stringify({ poses, maxToothError, maxLinkError, meshCount, triangles, cylinders }, null, 2),
);
