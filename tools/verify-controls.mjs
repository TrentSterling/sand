import assert from 'node:assert/strict';
import * as THREE from 'three';
import { armIK, forward, toolAttitude } from '../web/arm.js';
import { createMachine, machineDimensions as spec } from '../web/machine.js';
import { createSupport } from '../web/support.js';

const rig = createMachine(THREE);
const { limits } = spec;
const actual = new THREE.Vector3(),
  expected = new THREE.Vector3();
const interp = ([a, b], t) => a + (b - a) * t;
const turnError = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
let roundTrips = 0,
  maxReachError = 0,
  maxPitchError = 0,
  maxYawError = 0,
  pastVertical = 0;
for (let i = 0; i < 11; i++)
  for (let j = 0; j < 13; j++)
    for (let k = 0; k < 16; k++) {
      const pose = {
        boom: interp(limits.boom, i / 10),
        stick: interp(limits.stick, j / 12),
        curl: interp(limits.curl, k / 15),
        yaw: (i * 7 + j * 3 + k) * 0.19,
      };
      const target = forward(pose);
      const solved = armIK(target.r, target.h, target.pitch);
      assert(solved, 'Reachable target produced no solution');
      const rise = 0.19 * Math.sin(i),
        roll = 0.15 * Math.cos(j),
        chassisYaw = k * 0.29;
      rig.root.rotation.set(roll, chassisYaw, rise, 'YXZ');
      rig.root.position.set(1.4, 1.2, -2.6);
      rig.pose({ ...solved, yaw: pose.yaw });
      rig.root.updateMatrixWorld(true);
      rig.tip.getWorldPosition(actual);
      expected.set(target.r * Math.cos(pose.yaw), target.h, -target.r * Math.sin(pose.yaw));
      rig.root.localToWorld(expected);
      maxReachError = Math.max(maxReachError, actual.distanceTo(expected));
      const pinDirection = new THREE.Vector3(
        Math.sin(pose.yaw),
        0,
        Math.cos(pose.yaw),
      ).transformDirection(rig.root.matrixWorld);
      const worldUp = new THREE.Vector3(0, 1, 0);
      const radial = new THREE.Vector3().crossVectors(worldUp, pinDirection).normalize();
      const up = new THREE.Vector3().crossVectors(pinDirection, radial);
      const localEdge = new THREE.Vector3(
        Math.cos(target.pitch) * Math.cos(pose.yaw),
        -Math.sin(target.pitch),
        -Math.cos(target.pitch) * Math.sin(pose.yaw),
      );
      localEdge.transformDirection(rig.root.matrixWorld);
      const pitch = -Math.atan2(localEdge.dot(up), localEdge.dot(radial));
      const actualAttitude = toolAttitude(rig.bucket.matrixWorld.elements);
      maxPitchError = Math.max(maxPitchError, turnError(actualAttitude.pitch, pitch));
      maxYawError = Math.max(
        maxYawError,
        turnError(actualAttitude.yaw, -Math.atan2(radial.z, radial.x)),
      );
      if (Math.abs(pitch) > Math.PI / 2) pastVertical++;
      roundTrips++;
    }
assert(maxReachError < 1e-8 && maxPitchError < 1e-9 && maxYawError < 1e-9 && pastVertical > 100);

// Check boundary projection against a separate dense search of all legal
// angles at the chosen pitch. Include concrete-floor, far-reach and rear targets.
let limitTests = 0,
  maxExcess = 0,
  largestMiss = 0;
for (const r of [-2, 2.1, 5.8, 11])
  for (const h of [-3, 0.05, 3.6, 9])
    for (const requested of [-8, -1.22, -0.6, 0.5, 8]) {
      const solved = armIK(r, h, requested);
      assert(solved);
      for (const q of Object.keys(limits)) {
        assert(solved[q] >= limits[q][0] - 1e-10 && solved[q] <= limits[q][1] + 1e-10);
      }
      const achieved = forward(solved),
        p = achieved.pitch;
      const pitchMin = limits.curl[0] - spec.mountAngle - limits.boom[1] - limits.stick[1];
      const pitchMax = limits.curl[1] - spec.mountAngle - limits.boom[0] - limits.stick[0];
      assert(Math.abs(p - Math.max(pitchMin, Math.min(pitchMax, requested))) < 1e-9);
      const distance = Math.hypot(r - achieved.r, h - achieved.h);
      let sampled = Infinity;
      for (let i = 0; i <= 160; i++) {
        const b = interp(limits.boom, i / 160);
        const lo = Math.max(limits.stick[0], limits.curl[0] - p - spec.mountAngle - b);
        const hi = Math.min(limits.stick[1], limits.curl[1] - p - spec.mountAngle - b);
        if (lo > hi + 1e-10) continue;
        for (let j = 0; j <= 120; j++) {
          const s = interp([lo, hi], j / 120);
          const q = forward({ boom: b, stick: s, curl: p + spec.mountAngle + b + s });
          sampled = Math.min(sampled, Math.hypot(r - q.r, h - q.h));
        }
      }
      assert(Number.isFinite(sampled));
      maxExcess = Math.max(maxExcess, distance - sampled);
      largestMiss = Math.max(largestMiss, distance);
      limitTests++;
    }
assert(maxExcess < 1e-8, 'IK returned an endpoint farther than an available pose');

let worstShoePenetration = 0,
  planarError = 0;
const scenarios = [
  (x, z) => 1.1 + 0.24 * x - 0.17 * z,
  (x, z) => 0.9 + 0.32 * Math.exp(-x * x * 4) + 0.06 * z,
  (x, z) => 0.82 + (x > 0.55 && z > 0 ? 0.19 : 0),
];
for (const [index, ground] of scenarios.entries()) {
  const x = 0.1,
    z = 0.07,
    yaw = 0.35;
  const fit = createSupport(),
    support = fit(x, z, yaw, ground);
  const chassis = new THREE.Object3D();
  chassis.position.set(x, support.y, z);
  chassis.rotation.set(support.roll, yaw, support.rise, 'YXZ');
  chassis.updateMatrixWorld();
  for (const side of [-1.09, 1.09])
    for (let i = 0; i < 9; i++) {
      actual.set(interp([-1.62, 1.62], i / 8), 0, side).applyMatrix4(chassis.matrixWorld);
      const gap = actual.y - ground(actual.x, actual.z);
      worstShoePenetration = Math.max(worstShoePenetration, -gap);
      if (index === 0) planarError = Math.max(planarError, Math.abs(gap));
    }
  const again = fit(x, z, yaw, ground);
  assert(Math.abs(again.y - support.y) < 0.001);
}
assert(worstShoePenetration < 0.003 && planarError < 0.003);
console.log(
  JSON.stringify(
    {
      roundTrips,
      pastVertical,
      maxReachError,
      maxPitchError,
      maxYawError,
      limitTests,
      maxExcessOverSampledMetres: maxExcess,
      largestUnreachableResidualMetres: largestMiss,
      sampledSupportSurfaces: scenarios.length,
      worstShoePenetration,
      planarError,
    },
    null,
    2,
  ),
);
