import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { coloredGeometry } from './colored-geometry.js';
import { escapeYard } from './escape.js';
import { fleet } from './trucks.js';

const placements = [
  ['cone', -7.9, -5.4],
  ['cone', -7.2, -5.3],
  ['cone', -6.7, -5.2],
  ['cone', 9.2, -5.45],
  ['cone', 10, -5.44],
  ['cone', 10.8, -5.4],
  ['cone', 2.8, 1.28],
  ['drum', 3.35, 1.73],
  ['drum', 3.8, 2.4],
  ['cone', 4.3, 2.56],
  ['tyre', -3.3, -1.05],
  ['drum', -3.85, -1.38],
];
const mat = (color) => new T.MeshStandardMaterial({ color, roughness: 0.8 });
function propModel(kind) {
  const g = new T.Group();
  const add = (geometry, color, y = 0) => {
    const m = new T.Mesh(geometry, mat(color));
    m.position.y = y;
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    return m;
  };
  if (kind === 'cone') {
    add(new T.BoxGeometry(0.47, 0.075, 0.47), 0x303437, -0.26);
    add(new T.CylinderGeometry(0.038, 0.19, 0.52, 12), 0xe06828, 0.025);
    add(new T.CylinderGeometry(0.082, 0.112, 0.095, 12), 0xffeac7, 0.105);
  } else if (kind === 'drum') {
    add(new T.CylinderGeometry(0.28, 0.27, 0.8, 18), 0x447c78);
    for (const y of [-0.38, -0.18, 0.17, 0.38])
      add(new T.CylinderGeometry(0.291, 0.291, 0.032, 18), 0x334e4a, y);
    add(new T.CylinderGeometry(0.276, 0.276, 0.12, 18), 0xe5c478, 0.015);
    const bung = add(new T.CylinderGeometry(0.045, 0.045, 0.025, 10), 0x313839, 0.411);
    bung.position.x = 0.11;
  } else {
    const tire = add(new T.TorusGeometry(0.29, 0.115, 8, 22), 0x323330);
    tire.rotation.x = Math.PI / 2;
  }
  return g;
}
const vec = () => new T.Vector3();
export function createLooseProps(scene, exit) {
  const batches = new Map();
  const material = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  for (const kind of ['cone', 'drum', 'tyre']) {
    const parts = propModel(kind).children.map((part) => {
      part.updateMatrix();
      return coloredGeometry(part.geometry, part.matrix, part.material.color);
    });
    const count = placements.filter(([type]) => type === kind).length;
    const batch = new T.InstancedMesh(mergeGeometries(parts), material, count);
    batch.instanceMatrix.setUsage(T.DynamicDrawUsage);
    batch.frustumCulled = false;
    batch.castShadow = batch.receiveShadow = true;
    scene.add(batch);
    batches.set(kind, { batch, used: 0 });
  }
  function body(object, kind, x, z, r, h) {
    return { object, kind, x, z, r, h, v: vec(), spin: vec(), asleep: true, quiet: 0, hits: 0 };
  }
  const list = placements.map(([kind, x, z]) => {
    const group = batches.get(kind);
    const item = body(
      new T.Object3D(),
      kind,
      x,
      z,
      kind === 'drum' ? 0.29 : kind === 'cone' ? 0.23 : 0.405,
      kind === 'drum' ? 0.41 : kind === 'cone' ? 0.3 : 0.115,
    );
    item.batch = group.batch;
    item.slot = group.used++;
    return item;
  });
  function syncInstances() {
    for (const item of list) {
      item.object.updateMatrix();
      item.batch.setMatrixAt(item.slot, item.object.matrix);
    }
    for (const { batch } of batches.values()) batch.instanceMatrix.needsUpdate = true;
  }
  const plank = body(exit.plank, 'gate', 0, 0, 0.1, 0.08);
  const colliders = [
    { p: vec(), last: vec(), r: 1.36 },
    { p: vec(), last: vec(), r: 1.36 },
    { p: vec(), last: vec(), r: 0.57 },
  ];
  const truckBumpers = fleet.map(() => ({ p: vec(), last: vec(), r: 0.97 }));
  const axis = vec(),
    delta = vec(),
    velocity = vec(),
    up = vec(),
    end = vec(),
    rotation = new T.Quaternion();
  const center = vec(),
    along = vec(),
    nearest = vec();
  let initialized = false,
    broken = false,
    hits = 0;
  function floorAt(item, ground) {
    const p = item.object.position;
    if (item === plank) {
      end.set(0, 0, escapeYard.halfWidth - 0.18).applyQuaternion(plank.object.quaternion);
      return (
        Math.max(
          ground(p.x + end.x, p.z + end.z) - end.y,
          ground(p.x - end.x, p.z - end.z) + end.y,
        ) + 0.08
      );
    }
    up.set(0, 1, 0).applyQuaternion(item.object.quaternion);
    return (
      ground(p.x, p.z) + Math.abs(up.y) * item.h + item.r * Math.sqrt(Math.max(0, 1 - up.y * up.y))
    );
  }
  function strike(item, c, at, dt) {
    delta.subVectors(at, c.p);
    const distance = delta.length(),
      limit = c.r + item.r;
    if (distance >= limit) return false;
    velocity.subVectors(c.p, c.last).multiplyScalar(1 / dt);
    if (distance > 0.001) delta.multiplyScalar(1 / distance);
    else delta.set(1, 0, 0);
    const incoming = velocity.sub(item.v).dot(delta);
    if (incoming < 0.06 && (item.asleep || item === plank)) return false;
    const impulse = Math.min(
      4.3,
      Math.max(0, incoming) * 1.08 + Math.min(0.6, (limit - distance) * 3),
    );
    if (impulse < 0.035) return false;
    if (item.asleep) {
      hits++;
      item.hits++;
    }
    item.asleep = false;
    item.quiet = 0;
    item.v.addScaledVector(delta, impulse);
    item.v.y += Math.min(1, impulse * 0.38);
    item.spin.x += delta.z * impulse * 2.3;
    item.spin.z -= delta.x * impulse * 2.3;
    if (item === plank)
      item.spin.y += Math.sign(at.z - item.object.position.z || 1) * impulse * 0.9;
    return true;
  }
  function integrate(item, ground, dt) {
    if (item.asleep) return false;
    const p = item.object.position;
    item.v.y -= 9.81 * dt;
    p.addScaledVector(item.v, dt);
    const omega = item.spin.length();
    if (omega > 0.0001)
      item.object.quaternion
        .premultiply(
          rotation.setFromAxisAngle(axis.copy(item.spin).multiplyScalar(1 / omega), omega * dt),
        )
        .normalize();
    const floor = floorAt(item, ground),
      contact = p.y <= floor + 0.01;
    if (contact) {
      p.y = floor;
      if (item.v.y < 0) item.v.y = -item.v.y * 0.22;
      item.v.x *= 0.953;
      item.v.z *= 0.953;
      item.spin.multiplyScalar(0.957);
      if (item.v.lengthSq() + item.spin.lengthSq() < 0.012) item.quiet++;
      else item.quiet = 0;
      if (item.quiet > 18) {
        item.asleep = true;
        item.v.set(0, 0, 0);
        item.spin.set(0, 0, 0);
      }
    }
    return true;
  }
  return {
    get hits() {
      return hits;
    },
    get broken() {
      return broken;
    },
    reset(ground) {
      for (const item of list) {
        item.object.position.set(item.x, ground(item.x, item.z) + item.h, item.z);
        item.object.quaternion.identity();
      }
      syncInstances();
      for (const item of [...list, plank]) {
        item.v.set(0, 0, 0);
        item.spin.set(0, 0, 0);
        item.asleep = true;
        item.quiet = item.hits = 0;
      }
      initialized = broken = false;
      hits = 0;
    },
    tick(rig, tip, ground, dt, inEscape, frame, truckOffsets) {
      for (const c of colliders) c.last.copy(c.p);
      colliders[0].p.set(1.02, 0.88, 0).applyMatrix4(rig.root.matrixWorld);
      colliders[1].p.set(-1.02, 0.88, 0).applyMatrix4(rig.root.matrixWorld);
      colliders[2].p.copy(tip);
      if (truckOffsets)
        truckBumpers.forEach((c, i) => {
          const t = fleet[i];
          c.last.copy(c.p);
          c.p.set(
            t.x + truckOffsets[i] + t.heading * (t.length / 2 + (i === 0 ? 1.65 : 2.15)),
            0.85,
            t.z,
          );
        });
      if (!initialized) {
        for (const c of colliders) c.last.copy(c.p);
        if (truckOffsets) for (const c of truckBumpers) c.last.copy(c.p);
        initialized = true;
      }
      let moving = false;
      for (const item of list) {
        if (
          item.asleep &&
          frame % 12 === 0 &&
          Math.abs(floorAt(item, ground) - item.object.position.y) > 0.045
        )
          item.asleep = false;
        for (const c of colliders) strike(item, c, item.object.position, dt);
        if (truckOffsets) for (const c of truckBumpers) strike(item, c, item.object.position, dt);
        if (integrate(item, ground, dt)) moving = true;
      }
      if (moving) {
        for (let i = 0; i < list.length; i++)
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i],
              b = list[j];
            if (a.asleep && b.asleep) continue;
            delta.subVectors(b.object.position, a.object.position);
            const dist = delta.length(),
              over = a.r + b.r - dist;
            if (over <= 0 || dist < 0.001) continue;
            delta.divideScalar(dist);
            const speed = velocity.subVectors(a.v, b.v).dot(delta);
            if (speed > 0.05) {
              a.v.addScaledVector(delta, -0.58 * speed);
              b.v.addScaledVector(delta, 0.58 * speed);
              b.spin.z -= delta.x * speed;
              a.asleep = b.asleep = false;
            }
            a.object.position.addScaledVector(delta, -over * 0.5);
            b.object.position.addScaledVector(delta, over * 0.5);
          }
        syncInstances();
      }
      if (inEscape) {
        if (
          !broken &&
          (Math.abs(tip.x - escapeYard.gateX) < 1 ||
            Math.abs(rig.root.position.x - escapeYard.gateX) < 3.3)
        ) {
          plank.object.updateWorldMatrix(true, false);
          center.setFromMatrixPosition(plank.object.matrixWorld);
          along.setFromMatrixColumn(plank.object.matrixWorld, 2).normalize();
          for (const c of colliders) {
            end
              .copy(center)
              .addScaledVector(
                along,
                T.MathUtils.clamp(nearest.subVectors(c.p, center).dot(along), -2.36, 2.36),
              );
            if (strike(plank, c, end, dt)) {
              scene.attach(plank.object);
              broken = true;
              moving = true;
              break;
            }
          }
        }
        if (broken && integrate(plank, ground, dt)) moving = true;
      }
      return moving;
    },
  };
}
