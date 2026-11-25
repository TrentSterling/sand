import { Euler, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { forward } from './arm.js';
import { machineDimensions as rig } from './machine.js';

// SI lengths and seconds. Mass in tonnes makes impulses kN s and pressure kPa.
const up = new Vector3(0, 1, 0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const approach = (value, target, delta) => value + clamp(target - value, -delta, delta);
const dt = 1 / 120;
const rows = 10;
const gauge = 1.09;
const area = 0.405 * 0.34;
const vec = () => new Vector3();

function constraint() {
  return { axis: vec(), moment: vec(), spin: vec(), mass: 0, impulse: 0 };
}

export function createCrawler() {
  const position = vec(),
    rotation = new Quaternion(),
    velocity = vec(),
    omega = vec(),
    momentum = vec();
  const com = vec(),
    comWorld = vec(),
    comRate = vec(),
    relativeMomentum = vec(),
    relativeWorld = vec();
  const inertia = new Matrix3(),
    inverse = new Matrix3(),
    orient = new Matrix3(),
    transpose = new Matrix3();
  const rotMatrix = new Matrix4(),
    deltaQ = new Quaternion(),
    angles = new Euler(0, 0, 0, 'YXZ');
  const a = vec(),
    b = vec(),
    rel = vec(),
    fwd = vec(),
    lateral = vec(),
    armVector = vec();
  const read = { height: 0, soil: 0, nx: 0, ny: 1, nz: 0 };
  const weights = [6.9, 5.9, 3.65, 2.05, 1.05, 0.85, 0];
  const parts = weights.map(vec),
    oldParts = weights.map(vec);
  // Intrinsic moments about each component's centre. The parallel-axis term
  // below accounts for the changing reach of every articulated mass.
  const intrinsic = [5.8, 13.1, 10.8];
  const contacts = [];
  function addContact(x, y, z, side = 0, kind = 'body') {
    const pad = {
      local: new Vector3(x, y, z),
      rate: vec(),
      motion: vec(),
      world: vec(),
      r: vec(),
      n: constraint(),
      t: constraint(),
      l: constraint(),
      side,
      kind,
      active: false,
      softness: 0,
      bias: 0,
      limit: Infinity,
      soil: 0,
      normalLoad: 0,
      slip: 0,
      belt: 0,
      forwardMu: 0,
      lateralMu: 0,
    };
    if (kind !== 'truck') contacts.push(pad);
    return pad;
  }
  for (const side of [-1, 1]) {
    for (let j = 0; j < 8; j++)
      for (const across of [-0.17, 0.17])
        addContact((j - 3.5) * 0.405, 0, side * gauge + across, side, 'shoe');
    // Rounded idler/sprocket approaches, including the leading edge on a step.
    for (const end of [-1, 1]) {
      addContact(end * 1.72, 0.012, side * gauge, side, 'idler');
      addContact(end * 1.93, 0.11, side * gauge, side, 'idler');
      addContact(end * 2.07, 0.31, side * gauge, side, 'idler');
      addContact(end * 1.7, 0.95, side * gauge, 0, 'body');
    }
  }
  const bodyCorners = [];
  for (const x of [-1.98, 1.1])
    for (const z of [-1.03, 1.13]) bodyCorners.push({ x, z, point: addContact(0, 0, 0) });
  const tools = [
    [-0.86, -0.52, -0.49],
    [-0.86, -0.52, 0.49],
    [0.02, -0.85, 0],
  ];
  const bucketPads = tools.map(() => addContact(0, 0, 0, 0, 'bucket'));
  const armPads = [];
  for (const [link, length] of [
    ['boom', rig.boom],
    ['stick', rig.stick],
  ])
    for (const t of [0.16, 0.43, 0.72, 1])
      for (const edge of [-1, 1]) {
        const offset = link === 'boom' ? Math.sin(t * Math.PI) * 0.34 + edge * 0.22 : edge * 0.16;
        armPads.push({ link, x: length * t, y: offset, point: addContact(0, 0, 0, 0, 'steel') });
      }
  const hullRows = Array.from({ length: 14 }, () => addContact(0, 0, 0, 0, 'truck'));
  let touchingTruck = false, lastTruckRevision = -1;
  function truckRow(index, gap, point, axis, owner) {
    touchingTruck = true;
    const pad = hullRows[index];
    pad.owner = owner;
    pad.world.copy(point);
    pad.r.subVectors(point, comWorld);
    prepare(pad.n, pad.r, axis);
    lateral.copy(fwd).addScaledVector(axis, -fwd.dot(axis));
    if (lateral.lengthSq() < 0.01) lateral.set(0, 0, 1).addScaledVector(axis, -axis.z);
    lateral.normalize();
    prepare(pad.t, pad.r, lateral);
    prepare(pad.l, pad.r, b.crossVectors(lateral, axis).normalize());
    pad.n.impulse = pad.t.impulse = pad.l.impulse = 0;
    pad.bias = gap > 0 ? -gap / dt : Math.min(2.0, (Math.max(0, -gap - 0.001) * 0.22) / dt);
    pad.softness = 0.001;
    pad.forwardMu = pad.lateralMu = 0.25;
    active.push(pad);
  }
  const patches = contacts.filter((p) => p.side);
  const active = [];
  const belt = [0, 0],
    odometer = [0, 0],
    normalBySide = [0, 0];
  let mass = 20.4,
    initialized = false,
    sleeping = false,
    quiet = 0;
  let lastPose = [],
    lastMass = 0,
    supportCount = 0,
    maxPressure = 0,
    padSlip = 0,
    toolForce = 0;
  let bodyYaw = 0,
    actualSpeed = 0,
    parity = 0;
  const thrust = [0, 0];

  function localPart(out, r, y, z, c, s) {
    out.set(r * c + z * s, y, -r * s + z * c);
  }
  function massProperties(p, loadM3, initial = false) {
    const k = forward(p),
      c = Math.cos(p.yaw),
      s = Math.sin(p.yaw);
    const [sx, sy] = rig.shoulder,
      ex = sx + rig.boom * Math.cos(p.boom),
      ey = sy + rig.boom * Math.sin(p.boom);
    const ct = Math.cos(k.pitch),
      st = Math.sin(k.pitch);
    const wr = k.wristX,
      wh = k.wristY;
    for (let i = 0; i < parts.length; i++) oldParts[i].copy(parts[i]);
    a.copy(com);
    parts[0].set(0, 0.53, 0);
    localPart(parts[1], -0.13, 1.65, 0.12, c, s);
    localPart(parts[2], -1.71, 1.66, 0, c, s);
    localPart(parts[3], sx + 0.44 * (ex - sx), sy + 0.44 * (ey - sy) + 0.2, 0, c, s);
    localPart(parts[4], ex + 0.46 * (wr - ex), ey + 0.46 * (wh - ey), 0, c, s);
    localPart(parts[5], wr - 0.42 * st, wh - 0.42 * ct, 0, c, s);
    localPart(parts[6], wr - 0.15 * ct - 0.46 * st, wh + 0.15 * st - 0.46 * ct, 0, c, s);
    weights[6] = Math.max(0, loadM3) * 1.6;
    mass = 0;
    com.set(0, 0, 0);
    for (let i = 0; i < parts.length; i++) {
      mass += weights[i];
      com.addScaledVector(parts[i], weights[i]);
    }
    com.multiplyScalar(1 / mass);
    comRate.subVectors(com, a).multiplyScalar(initial ? 0 : 60);
    // Gaining soil at the lip adds mass there, without shifting the carrier origin.
    if (!initial && mass !== lastMass) {
      b.subVectors(parts[6], a).multiplyScalar((mass - lastMass) / mass);
      comRate.addScaledVector(b, -60);
      comWorld.add(b.applyQuaternion(rotation));
    }
    let [xx, yy, zz] = intrinsic,
      xy = 0,
      xz = 0,
      yz = 0;
    relativeMomentum.set(0, 0, 0);
    for (let i = 0; i < parts.length; i++) {
      const m = weights[i];
      rel.subVectors(parts[i], com);
      const { x, y, z } = rel;
      xx += m * (y * y + z * z);
      yy += m * (x * x + z * z);
      zz += m * (x * x + y * y);
      xy -= m * x * y;
      xz -= m * x * z;
      yz -= m * y * z;
      if (!initial)
        relativeMomentum.addScaledVector(
          b.crossVectors(rel, armVector.subVectors(parts[i], oldParts[i]).multiplyScalar(60)),
          m,
        );
    }
    // Distributed inertia of the long links about their own moving centres.
    for (let link = 0; link < 2; link++) {
      const length = link ? rig.stick : rig.boom;
      const angle = p.boom + (link ? p.stick : 0);
      const spread = (weights[3 + link] * length * length) / 12;
      const x = Math.cos(angle) * c,
        y = Math.sin(angle),
        z = -Math.cos(angle) * s;
      xx += spread * (1 - x * x);
      yy += spread * (1 - y * y);
      zz += spread * (1 - z * z);
      xy -= spread * x * y;
      xz -= spread * x * z;
      yz -= spread * y * z;
      if (!initial && lastPose.length) {
        const pitchRate = 60 * (angle - lastPose[0] - (link ? lastPose[1] : 0));
        const yawRate = 60 * (p.yaw - lastPose[3]);
        a.set(s * pitchRate, yawRate, c * pitchRate);
        b.set(x, y, z);
        a.addScaledVector(b, -a.dot(b));
        relativeMomentum.addScaledVector(a, spread);
      }
    }
    inertia.set(xx, xy, xz, xy, yy, yz, xz, yz, zz).invert();
    for (const body of bodyCorners) {
      a.copy(body.point.local);
      localPart(body.point.local, body.x, body.x < 0 ? 2.37 : 2.9, body.z, c, s);
      body.point.rate.subVectors(body.point.local, a).multiplyScalar(initial ? 0 : 60);
    }
    for (let i = 0; i < bucketPads.length; i++) {
      const point = bucketPads[i],
        [x, y, z] = tools[i];
      a.copy(point.local);
      localPart(point.local, wr + x * ct + y * st, wh - x * st + y * ct, z, c, s);
      point.rate.subVectors(point.local, a).multiplyScalar(initial ? 0 : 60);
    }
    for (const { link, x, y, point } of armPads) {
      const boom = link === 'boom',
        angle = boom ? p.boom : p.boom + p.stick;
      a.copy(point.local);
      localPart(
        point.local,
        (boom ? sx : ex) + Math.cos(angle) * x - Math.sin(angle) * y,
        (boom ? sy : ey) + Math.sin(angle) * x + Math.cos(angle) * y,
        0,
        c,
        s,
      );
      point.rate.subVectors(point.local, a).multiplyScalar(initial ? 0 : 60);
    }
    lastMass = mass;
  }
  function reset(p, load = 0, x = 0, y = 0, z = 0, yaw = 0) {
    rotation.setFromAxisAngle(up, yaw);
    velocity.set(0, 0, 0);
    momentum.set(0, 0, 0);
    omega.set(0, 0, 0);
    massProperties(p, load, true);
    position.set(x, y, z);
    comWorld.copy(com).applyQuaternion(rotation).add(position);
    for (const pad of contacts) {
      pad.active = false;
      pad.normalLoad = pad.slip = 0;
    }
    belt.fill(0);
    odometer.fill(0);
    normalBySide.fill(0);
    quiet = 0;
    sleeping = false;
    initialized = true;
    lastPose = [p.boom, p.stick, p.curl, p.yaw, load];
    bodyYaw = yaw;
    angles.setFromQuaternion(rotation, 'YXZ');
    actualSpeed = padSlip = maxPressure = toolForce = supportCount = 0;
  }
  function prepare(row, r, dir) {
    row.axis.copy(dir);
    row.moment.crossVectors(r, dir);
    row.spin.copy(row.moment).applyMatrix3(inverse);
    row.mass = 1 / mass + row.moment.dot(row.spin);
    row.impulse = 0;
  }
  function apply(row, amount) {
    velocity.addScaledVector(row.axis, amount / mass);
    omega.addScaledVector(row.spin, amount);
    momentum.addScaledVector(row.moment, amount);
  }
  function solve(row, pad, speed, soft, min, max) {
    const relative = velocity.dot(row.axis) + omega.dot(row.moment) + pad.motion.dot(row.axis);
    const change = (speed - relative - soft * row.impulse) / (row.mass + soft);
    const next = clamp(row.impulse + change, min, max);
    apply(row, next - row.impulse);
    row.impulse = next;
  }
  function substep(sample, obstacle, turning, p) {
    orient.setFromMatrix4(rotMatrix.makeRotationFromQuaternion(rotation));
    inverse.multiplyMatrices(orient, inertia).multiply(transpose.copy(orient).transpose());
    relativeWorld.copy(relativeMomentum).applyQuaternion(rotation);
    omega.subVectors(momentum, relativeWorld).applyMatrix3(inverse);
    velocity.y -= 9.81 * dt;
    fwd.set(1, 0, 0).applyQuaternion(rotation);
    active.length = 0;
    thrust.fill(0);
    parity ^= 1;
    for (const pad of contacts) {
      pad.r.subVectors(pad.local, com).applyQuaternion(rotation);
      pad.world.copy(comWorld).add(pad.r);
      const { x, y, z } = pad.world;
      sample(x, z, read);
      let gap = (y - read.height) * read.ny;
      a.set(read.nx, read.ny, read.nz);
      let soil = read.soil;
      // A digging edge can yield loose material. At bedrock the hard contact
      // can transmit the arm force to the entire machine.
      const softTool = pad.kind === 'bucket' && soil > 0.03 && y > 0.025;
      if (soil > 0.03 && y <= 0.018) {
        a.copy(up);
        gap = y;
        soil = 0;
      }
      if (obstacle) {
        const distance = obstacle(x, y, z, b);
        // At a buried concrete face the rigid stop takes over from yielding sand.
        if (distance < gap || (soil > 0.015 && distance <= 0.008)) {
          gap = distance;
          a.copy(b);
          soil = 0;
        }
      }
      if (gap > 0.026) {
        pad.active = false;
        pad.normalLoad = 0;
        pad.slip = 0;
        continue;
      }
      const warm = pad.active && pad.n.axis.dot(a) > 0.96 ? 0.8 : 0;
      const prevN = pad.n.impulse * warm,
        prevT = pad.t.impulse * warm,
        prevL = pad.l.impulse * warm;
      pad.active = true;
      pad.soil = soil;
      pad.motion.subVectors(pad.rate, comRate).applyQuaternion(rotation);
      prepare(pad.n, pad.r, a);
      b.copy(fwd).addScaledVector(a, -fwd.dot(a));
      if (b.lengthSq() < 0.01) b.set(0, 0, 1).addScaledVector(a, -a.z);
      b.normalize();
      prepare(pad.t, pad.r, b);
      lateral.crossVectors(b, a).normalize();
      prepare(pad.l, pad.r, lateral);
      pad.bias = gap > 0 ? -gap / dt : Math.min(2.4, (Math.max(0, -gap - 0.001) * 0.19) / dt);
      pad.softness = soil > 0.015 ? 0.55 : 0.055;
      pad.limit = softTool && soil > 0.03 ? (12 + Math.min(1, -gap) * 24) * dt : Infinity;
      if (pad.side && soil > 0.018) {
        const depth = Math.max(0, -gap),
          packing = read.packing ?? 0;
        const closing = Math.max(
          0,
          -velocity.dot(pad.n.axis) - omega.dot(pad.n.moment) - pad.motion.dot(pad.n.axis),
        );
        const pressure = 4 + depth * (338.8 + 1628.0 * packing) + closing * (70 + 45 * packing);
        pad.limit = Math.min(pressure, 96 + 180 * packing + 520 * depth) * area * dt;
        // Sand yields on loading and recovers slowly. Applying the rigid
        // contact penetration correction to a buried shoe launches the carrier.
        pad.bias = gap > 0 ? -gap / dt : Math.min(0.32, Math.max(0, depth - 0.018) * 1.65);
      }
      pad.belt = pad.side && a.y > 0.3 ? belt[pad.side > 0 ? 1 : 0] : 0;
      pad.forwardMu = a.y < 0.2 ? 0.12 : soil > 0.02 ? 0.93 : 0.9;
      pad.lateralMu = a.y < 0.2 ? 0.12 : pad.side ? (turning ? 0.31 : 0.8) : 0.55;
      pad.n.impulse = Math.min(prevN, pad.limit);
      pad.t.impulse = prevT;
      pad.l.impulse = prevL;
      apply(pad.n, pad.n.impulse);
      apply(pad.t, prevT);
      apply(pad.l, prevL);
      if (pad.side) thrust[pad.side > 0 ? 1 : 0] += prevT;
      active.push(pad);
    }
    if (obstacle?.hulls) obstacle.hulls(p, position, rotation, truckRow);
    for (let pass = 0; pass < rows; pass++) {
      for (let k = 0; k < active.length; k++) {
        const pad = active[(pass + parity) % 2 ? k : active.length - 1 - k];
        solve(pad.n, pad, pad.bias, pad.softness, 0, pad.limit);
        // Each final drive has one torque budget. A loaded end of a rigid
        // track can transmit that thrust even when most other shoes are clear.
        // The small patch on the rounded idler can carry an impact load;
        // it cannot anchor an entire final drive during a reversal.
        const shear = pad.side ? 85 : Infinity;
        const drive = Math.min(pad.n.impulse * pad.forwardMu, shear * dt);
        const i = pad.side > 0 ? 1 : 0,
          before = pad.t.impulse;
        const rest = pad.side ? thrust[i] - before : 0,
          budget = pad.side ? 92 * dt : Infinity;
        solve(
          pad.t,
          pad,
          pad.belt,
          0.025,
          clamp(-budget - rest, -drive, drive),
          clamp(budget - rest, -drive, drive),
        );
        if (pad.side) thrust[i] += pad.t.impulse - before;
        const share = pad.n.impulse > 1e-9 ? pad.t.impulse / (pad.n.impulse * pad.forwardMu) : 0;
        const side = pad.lateralMu * pad.n.impulse * Math.sqrt(Math.max(0, 1 - share * share));
        solve(pad.l, pad, 0, 0.13, -side, side);
      }
    }
    normalBySide.fill(0);
    supportCount = toolForce = maxPressure = padSlip = 0;
    for (const pad of active) {
      pad.normalLoad = pad.n.impulse / dt;
      const f = velocity.dot(pad.t.axis) + omega.dot(pad.t.moment) + pad.motion.dot(pad.t.axis);
      const l = velocity.dot(pad.l.axis) + omega.dot(pad.l.moment) + pad.motion.dot(pad.l.axis);
      pad.slip = Math.hypot(pad.belt - f, l);
      if (pad.kind === 'truck') obstacle.react(pad.owner, pad.world, pad.n.axis, pad.normalLoad);
      if (pad.kind === 'bucket') toolForce += pad.normalLoad;
      if (pad.side && pad.normalLoad > 0.05) {
        normalBySide[pad.side > 0 ? 1 : 0] += pad.normalLoad;
        supportCount++;
        maxPressure = Math.max(maxPressure, pad.normalLoad / area);
        padSlip += pad.normalLoad * pad.slip;
      }
    }
    padSlip /= Math.max(1, normalBySide[0] + normalBySide[1]);
    // Compression ahead of a rocking shoe and plastic unloading behind it
    // dissipate energy. This contact moment vanishes in flight and at rest.
    let rockingLoad = 0;
    for (const pad of active)
      if (pad.side)
        rockingLoad += pad.normalLoad * (pad.n.axis.y > 0.2 ? 1 : 0) * (pad.soil > 0.02 ? 1 : 0.65);
    if (rockingLoad > 0) {
      for (let axis = 0; axis < 2; axis++) {
        a.set(axis, 0, 1 - axis).applyQuaternion(rotation);
        const rate = omega.dot(a),
          effective = b.copy(a).applyMatrix3(inverse);
        const lever = axis === 0 ? 1.62 : 0.78;
        const impulse =
          -Math.sign(rate) *
          Math.min(
            Math.abs(rate) / a.dot(effective),
            rockingLoad * dt * Math.min(lever, Math.abs(rate) * 0.4 + rate * rate * 14),
          );
        momentum.addScaledVector(a, impulse);
        omega.addScaledVector(effective, impulse);
      }
    }
    // The moving foot pushes a wedge of loose sand. Its resistance acts at
    // the contact and disappears on bedrock or when the shoe lifts.
    for (const pad of active) {
      if (!pad.side || pad.soil < 0.018 || pad.normalLoad <= 0) continue;
      const speed = velocity.dot(pad.t.axis) + omega.dot(pad.t.moment);
      const damper = Math.min(
        Math.abs(speed) / pad.t.mass,
        pad.normalLoad * dt * Math.min(0.27, Math.abs(speed) * 0.32),
      );
      apply(pad.t, -Math.sign(speed) * damper);
    }
    comWorld.addScaledVector(velocity, dt);
    const speed = omega.length();
    if (speed > 1e-10)
      rotation
        .premultiply(deltaQ.setFromAxisAngle(a.copy(omega).multiplyScalar(1 / speed), speed * dt))
        .normalize();
    position.copy(comWorld).sub(a.copy(com).applyQuaternion(rotation));
  }
  function step(p, load, throttle, steer, sample, obstacle) {
    if (!initialized) reset(p, load);
    const moving =
      lastPose[0] !== p.boom ||
      lastPose[1] !== p.stick ||
      lastPose[2] !== p.curl ||
      lastPose[3] !== p.yaw ||
      lastPose[4] !== load;
    if (sleeping && !moving && !throttle && !steer) {
      let same = true;
      for (const pad of patches) {
        sample(pad.world.x, pad.world.z, read);
        if (Math.abs(read.height - pad.restHeight) > 0.002) {
          same = false;
          break;
        }
      }
      if (same && (!obstacle?.hulls || (!touchingTruck && lastTruckRevision === obstacle.revision()))) return;
    }
    sleeping = false;
    touchingTruck = false;
    if (obstacle?.hulls) lastTruckRevision = obstacle.revision();
    massProperties(p, load);
    lastPose[0] = p.boom;
    lastPose[1] = p.stick;
    lastPose[2] = p.curl;
    lastPose[3] = p.yaw;
    lastPose[4] = load;
    for (let i = 0; i < 2; i++) {
      // Meter pump flow under grade load. Two drives share 82 kW; the same
      // pressure can produce full drawbar pull at a lower belt speed.
      const grade = Math.abs(fwd.y),
        loose = patches.some((p) => p.soil > 0.08 && p.normalLoad > 2);
      const travelLimit = Math.min(loose ? 0.84 : 1.52, 82 / (mass * 9.81 * (grade + 0.085)));
      const target = clamp(travelLimit * throttle + (i ? 1 : -1) * 0.94 * steer, -1.52, 1.52);
      belt[i] = approach(belt[i], target, (target ? 1.55 : 2.7) / 60);
      odometer[i] += belt[i] / 60;
    }
    for (let i = 0; i < 2; i++) substep(sample, obstacle, Math.abs(belt[0] - belt[1]) > 0.1, p);
    angles.setFromQuaternion(rotation, 'YXZ');
    bodyYaw = angles.y;
    actualSpeed = velocity.dot(fwd);
    quiet =
      !moving &&
      !throttle &&
      !steer &&
      !belt[0] &&
      !belt[1] &&
      supportCount >= 5 &&
      velocity.lengthSq() < 0.0001 &&
      omega.lengthSq() < 0.0001
        ? quiet + 1
        : 0;
    if (quiet >= 45) {
      sleeping = true;
      velocity.set(0, 0, 0);
      momentum.set(0, 0, 0);
      omega.set(0, 0, 0);
      actualSpeed = 0;
      for (const pad of patches) {
        sample(pad.world.x, pad.world.z, read);
        pad.restHeight = read.height;
      }
    }
  }
  function state() {
    return {
      massKg: mass * 1000,
      comLocal: com.toArray(),
      comWorld: comWorld.toArray(),
      speed: actualSpeed,
      verticalSpeed: velocity.y,
      pitch: angles.z,
      roll: angles.x,
      yaw: bodyYaw,
      angularVelocity: omega.toArray(),
      leftLoadKN: normalBySide[0],
      rightLoadKN: normalBySide[1],
      supportCount,
      peakKPa: maxPressure,
      slip: padSlip,
      bucketReactionKN: toolForce,
      beltSpeed: [...belt],
      sleeping,
    };
  }
  return {
    position,
    rotation,
    angles,
    patches,
    belt,
    odometer,
    comWorld,
    reset,
    step,
    state,
    get speed() {
      return actualSpeed;
    },
    get bucketForce() {
      return toolForce;
    },
    get asleep() {
      return sleeping;
    },
  };
}
