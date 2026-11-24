import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { carrierClearance, createMachine, machineDimensions } from './machine.js';
import { armIK, forward, toolAttitude } from './arm.js';
import { createCrawler } from './crawler.js';
import { driveGround, yardClearance } from './drive-ground.js';
import { createContactView } from './contact-view.js';
import { createQuarry } from './quarry.js';
import { createGround, createStream } from './terrain.js';
import { createTreads, renderedHeight } from './treads.js';

const byId = (id) => document.getElementById(id);
const clamp = THREE.MathUtils.clamp,
  mix = THREE.MathUtils.lerp;
const units = 64000,
  step = 1 / 60;
const note = (text) => {
  byId('feedback').textContent = text;
};
const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const fmt = (v) => (v / units).toFixed(2) + ' m³';

function markZone(scene) {
  const points = [];
  for (let i = 0; i < 64; i += 2) {
    for (const k of [i, i + 1])
      points.push(
        new THREE.Vector3(
          1.95 * Math.cos((k * Math.PI) / 32),
          0.035,
          1.95 * Math.sin((k * Math.PI) / 32),
        ),
      );
  }
  const ring = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: 0xffcc55 }),
  );
  ring.position.set(-4.6, 0, 2.7);
  ring.visible = false;
  scene.add(ring);
  return ring;
}

async function start() {
  const offlineSource = '<!doctype html>\n' + document.documentElement.outerHTML;
  const bytes = Uint8Array.from(atob(byId('wasm').textContent.trim()), (c) => c.charCodeAt(0));
  const { instance } = await WebAssembly.instantiate(bytes);
  const core = instance.exports;
  const capacity = core.bucket_capacity();
  const renderer = new THREE.WebGLRenderer({
    canvas: byId('view'),
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(40, 1, 0.12, 240);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 4;
  controls.maxDistance = 39;
  controls.maxPolarAngle = Math.PI * 0.484;
  controls.minPolarAngle = 0.13;
  controls.enablePan = false;
  createQuarry(THREE, scene);
  const terrain = createGround(scene),
    stream = createStream(scene),
    rig = createMachine(THREE),
    treads = createTreads(THREE, scene);
  scene.add(rig.root);
  const chassis = createCrawler();
  let slewRate = 0;
  const contactView = createContactView(scene, chassis);
  let sampleDrive,
    driveInput = 0,
    steerInput = 0,
    chassisMs = 0;
  let poseError = 0,
    contactStop = false,
    sideView = false,
    dragTarget = null,
    dragId = null;
  const orbitOffset = new THREE.Vector3();
  const cast = new THREE.Raycaster(),
    armPlane = new THREE.Plane(),
    touchPoint = new THREE.Vector3();
  const targetMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.095, 0.12, 32),
    new THREE.MeshBasicMaterial({ color: 0xffd04f, depthTest: false, side: THREE.DoubleSide }),
  );
  targetMarker.visible = false;
  targetMarker.renderOrder = 5;
  scene.add(targetMarker);
  const ground = (x, z) => core.world_ground(w, x, z);
  function protectTool(old) {
    if (old.boom === p.boom && old.stick === p.stick && old.curl === p.curl && old.yaw === p.yaw)
      return;
    contactStop = false;
    const margin = carrierClearance(p);
    if (margin >= 0 || margin >= carrierClearance(old)) return;
    const goal = { ...p };
    let good = 0,
      bad = 1;
    const floor = Math.min(0, carrierClearance(old));
    for (let i = 0; i < 9; i++) {
      const t = (good + bad) / 2;
      for (const joint of ['boom', 'stick', 'curl', 'yaw'])
        p[joint] = mix(old[joint], goal[joint], t);
      if (carrierClearance(p) >= floor) good = t;
      else bad = t;
    }
    for (const joint of ['boom', 'stick', 'curl', 'yaw'])
      p[joint] = mix(old[joint], goal[joint], good);
    contactStop = true;
  }
  const marked = markZone(scene),
    tip = new THREE.Vector3();
  let w = 0,
    p,
    base,
    sequence = [],
    action = '',
    manual = false,
    paused = false,
    frame = 0,
    job = 0,
    done = false;
  let targetBase = 0,
    busy = false,
    pendingReset = false,
    clock = 0,
    markMass = 0,
    maxLoad = 0;
  let simMs = 0,
    uploadBytes = 0,
    visits = 0,
    fps = 60,
    terrainMs = 0,
    lastNow = 0,
    accum = 0;
  let frameSum = 0,
    frameCount = 0,
    renderTicks = 0,
    orderTime = 0;
  let previousJointState = [],
    availableTorque = 1;
  const keyHeld = new Set(),
    pointerHeld = new Map();
  const replay = new Float32Array(5 * 3600);
  const shoeEvents = Array(3600).fill(null);
  let drove = false;
  let trackMoved = false;
  const source = { x: 5.45, z: -0.15 },
    bay = { x: 0, z: 5.55 },
    berm = { x: -4.6, z: 2.7 };
  let savedMotion = 0,
    trackYaw = 0,
    travel = 0,
    selected = '',
    sound = null;
  const destination = () => (job === 1 ? berm : bay);
  function markAmount() {
    const height = new Int32Array(core.memory.buffer, core.world_height(w), 256 * 256);
    let sum = 0;
    for (let z = 133; z <= 165; z++)
      for (let x = 74; x <= 106; x++) {
        if (((x + 0.5) / 8 - 16 - berm.x) ** 2 + ((z + 0.5) / 8 - 16 - berm.z) ** 2 < 1.95 ** 2)
          sum += height[z * 256 + x];
      }
    return sum;
  }
  const massHere = () => (job === 1 ? markAmount() : core.world_bay(w));
  const goal = () => (job === 0 ? 0.75 : 1.5);
  const targetText = () =>
    job === 0
      ? 'Deliver 0.75 m³ to the weigh bay'
      : job === 1
        ? 'Build a 1.50 m³ stockpile inside the ring'
        : 'Free dig · open quarry';
  let framing = 1;
  function resize(home = false) {
    const width = innerWidth,
      height = innerHeight,
      aspect = width / height;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.65));
    renderer.setSize(width, height, false);
    scene.userData.renderHeight = renderer.domElement.height;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    const factor = clamp(1.02 / aspect, 1, 2.25);
    if (home) {
      controls.target.set(1.15, 1.5, 0.9);
      camera.position
        .copy(controls.target)
        .add(new THREE.Vector3(8.7, 6.5, 12.3).multiplyScalar(factor));
      controls.update();
    } else if (factor !== framing) {
      camera.position
        .sub(controls.target)
        .multiplyScalar(factor / framing)
        .add(controls.target);
      controls.update();
    }
    framing = factor;
  }
  function togglePanels(id) {
    for (const name of ['help', 'lab']) {
      const open = name === id && byId(name).hidden;
      byId(name).hidden = !open;
      byId(name + 'Toggle').setAttribute('aria-expanded', String(open));
    }
  }
  function setManual(on) {
    if (busy) return;
    if (!on && sideView) toggleCutView();
    endDrag();
    poseError = 0;
    contactStop = false;
    manual = on;
    byId('manualPanel').hidden = !on;
    byId('assistPanel').hidden = on;
    byId('manual').setAttribute('aria-expanded', String(on));
    byId('manual').setAttribute('aria-pressed', String(on));
    byId('manual').textContent = on ? 'Assisted' : 'Manual';
    keyHeld.clear();
    pointerHeld.clear();
    sequence = [];
    action = '';
    select('');
    note(
      on
        ? 'Hold a control to move. Double-click the ground to position the teeth.'
        : 'Choose Dig to line up the next cut.',
    );
  }
  function select(name) {
    selected = name;
    document
      .querySelectorAll('[data-action]')
      .forEach((el) => el.setAttribute('aria-pressed', String(el.dataset.action === name)));
  }
  function setPause(on) {
    if (on) endDrag();
    paused = on;
    accum = 0;
    byId('pause').textContent = on ? 'Resume' : 'Pause';
    byId('step').disabled = !on;
  }
  function reset() {
    if (busy) {
      pendingReset = true;
      return;
    }
    if (w) core.world_drop(w);
    if (sideView) toggleCutView();
    w = core.world_new(0);
    sampleDrive = driveGround(core, w);
    shoeEvents.fill(null);
    drove = false;
    base = { x: 0, y: 0, z: 0 };
    trackYaw = 0;
    travel = 0;
    job = 0;
    done = false;
    orderTime = 0;
    clock = 0;
    frame = 0;
    savedMotion = 0;
    targetBase = 0;
    maxLoad = 0;
    marked.visible = false;
    previousJointState = [];
    availableTorque = 1;
    treads.reset();
    p = { ...armIK(5.82, 2.65, -0.74), yaw: 0 };
    chassis.reset(p, 0);
    slewRate = 0;
    driveInput = steerInput = 0;
    setManual(false);
    setPause(false);
    byId('nextJob').hidden = true;
    byId('goal').textContent = targetText();
    byId('benchResult').textContent = '';
    note('Take a bite from the bank. Start with Dig.');
    updateMachine();
    terrain.sync(core, w);
    stream(core, w);
    hud();
    resize(true);
  }
  function nextJob() {
    if (busy || !done || job >= 2) return;
    job++;
    targetBase = massHere();
    orderTime = clock;
    done = false;
    marked.visible = job === 1;
    byId('goal').textContent = targetText();
    byId('nextJob').hidden = true;
    note(
      job === 1
        ? 'Stockpile order. Swing now lines up with the striped ground ring.'
        : 'Both orders complete. Drive, reshape the quarry, or compare the CPU solvers.',
    );
    hud();
  }
  function aimed(target) {
    const local = rig.root.worldToLocal(
      new THREE.Vector3(target.x, target.y ?? ground(target.x, target.z), target.z),
    );
    return { r: Math.hypot(local.x, local.z), h: local.y, yaw: -Math.atan2(local.z, local.x) };
  }
  function queue(name) {
    if (busy) return;
    if (manual) setManual(false);
    if (paused) setPause(false);
    const start = forward(p),
      bank = aimed(source),
      dest = aimed(destination());
    const make = (r, h, pitch, yaw, ticks) => ({ r, h, pitch, yaw, ticks });
    let goals;
    switch (name) {
      case 'dig': {
        const angle = Math.atan2(source.z - base.z, source.x - base.x);
        const radial = Math.hypot(source.x - base.x, source.z - base.z);
        const face = (offset, depth) => {
          const x = base.x + (radial + offset) * Math.cos(angle),
            z = base.z + (radial + offset) * Math.sin(angle);
          return aimed({ x, z, y: Math.max(0.18, renderedHeight(ground, x, z) - depth) });
        };
        const entry = face(0.5, 0.12),
          middle = face(-0.43, 0.31),
          exit = face(-1.57, 0.26);
        goals = [
          make(start.r, Math.max(start.h, 2.7), start.pitch, start.yaw, 32),
          make(entry.r, entry.h + 0.64, -0.85, entry.yaw, 75),
          make(entry.r, entry.h, -0.85, entry.yaw, 30),
          make(middle.r, middle.h, -0.17, middle.yaw, 52),
          make(exit.r, exit.h, 0.55, exit.yaw, 68),
          { ...make(exit.r - 0.12, exit.h + 0.85, 0.52, exit.yaw, 42), breakout: true },
        ];
        note('Cutting a slice off the face. Watch the lip curl toward the tracks.');
        break;
      }
      case 'lift':
        goals = [make(start.r, Math.max(start.h, 2.9), 0.44, start.yaw, 58)];
        note('Curling the bucket and lifting clear.');
        break;
      case 'swing':
        goals = [
          make(start.r, Math.max(start.h, 2.65), 0.44, start.yaw, 32),
          make(
            dest.r,
            2.65,
            0.44,
            dest.yaw,
            Math.max(100, Math.ceil(Math.abs(angleDelta(start.yaw, dest.yaw)) * dest.r * 22)),
          ),
        ];
        note(job === 1 ? 'Slewing to the stockpile ring.' : 'Slewing to the weigh bay.');
        break;
      case 'dump':
        goals = [
          make(start.r, start.h, -1.22, start.yaw, 51),
          make(start.r, start.h, -1.22, start.yaw, 32),
        ];
        note('Opening the bucket. The load scores where it lands.');
        break;
      default:
        return;
    }
    sequence = goals;
    action = name;
    select(name);
  }
  function animateArm() {
    if (!sequence.length) return;
    if (
      action === 'dig' &&
      sequence.length <= 3 &&
      !sequence[0].breakout &&
      core.world_load(w) >= capacity * 0.965
    ) {
      // A full bucket breaks out along the cut face while the stick draws in.
      const here = forward(p);
      sequence = [
        {
          r: here.r - 0.32,
          h: here.h + 0.95,
          pitch: 0.5,
          yaw: here.yaw,
          ticks: 48,
          breakout: true,
        },
      ];
    }
    const s = sequence[0];
    if (!s.begin) {
      s.begin = forward(p);
      s.elapsed = 0;
    }
    s.elapsed += action === 'dig' ? availableTorque : 1;
    const t = Math.min(1, s.elapsed / s.ticks),
      f = t * t * (3 - 2 * t),
      a = s.begin;
    const r = mix(a.r, s.r, f),
      h = mix(a.h, s.h, f),
      pitch = mix(a.pitch, s.pitch, f);
    const goal = armIK(r, h, pitch);
    const speed = availableTorque;
    for (const [joint, rate] of [
      ['boom', 0.016],
      ['stick', 0.023],
      ['curl', 0.033],
    ]) {
      p[joint] += clamp(goal[joint] - p[joint], -rate * speed, rate * speed);
    }
    p.yaw += clamp(angleDelta(p.yaw, a.yaw + angleDelta(a.yaw, s.yaw) * f), -0.023, 0.023);
    const achieved = forward(p);
    poseError = Math.hypot(achieved.r - r, achieved.h - h);
    const atStops =
      Math.max(
        Math.abs(p.boom - goal.boom),
        Math.abs(p.stick - goal.stick),
        Math.abs(p.curl - goal.curl),
      ) < 0.001;
    if (t === 1 && (contactStop || (atStops && Math.abs(angleDelta(p.yaw, s.yaw)) < 0.006))) {
      sequence.shift();
      if (!sequence.length) {
        const load = core.world_load(w);
        if (action === 'dig')
          note(
            load > 500
              ? 'Load caught. Lift it clear of the bank.'
              : 'Shallow cut. Move closer or lower the teeth in manual mode.',
          );
        if (action === 'lift') note('Bucket up. Swing to the delivery point.');
        if (action === 'swing') note('Over the target. Dump when ready.');
        if (action === 'dump' && !done) note('Load released. Dig again for another pass.');
        if (poseError > 0.1 || contactStop)
          note(
            contactStop
              ? 'Tool at hard contact. Raise the boom or draw the stick back.'
              : 'Joint stop reached. Choose a closer point or reposition the tracks.',
          );
        action = '';
        select('');
      }
    }
  }
  const keyMap = {
    KeyW: 'boomUp',
    KeyS: 'boomDown',
    KeyE: 'stickOut',
    KeyD: 'stickIn',
    KeyR: 'curlIn',
    KeyF: 'curlOut',
    KeyQ: 'left',
    KeyA: 'right',
    ArrowUp: 'driveForward',
    ArrowDown: 'driveBack',
    ArrowLeft: 'steerLeft',
    ArrowRight: 'steerRight',
  };
  function moveManual() {
    const held = (k) => keyHeld.has(k) || [...pointerHeld.values()].includes(k);
    const axis = (a, b) => Number(held(a)) - Number(held(b));
    const curlInput = axis('curlIn', 'curlOut') * 0.026 * availableTorque;
    if (dragTarget) {
      dragTarget.pitch = clamp(dragTarget.pitch + curlInput, -3.1, 2.9);
      const want = armIK(dragTarget.r, dragTarget.h, dragTarget.pitch);
      for (const [joint, rate] of [
        ['boom', 0.014],
        ['stick', 0.022],
        ['curl', 0.032],
      ]) {
        p[joint] += clamp(want[joint] - p[joint], -rate * availableTorque, rate * availableTorque);
      }
    } else {
      p.boom = clamp(
        p.boom + axis('boomUp', 'boomDown') * 0.012 * availableTorque,
        ...machineDimensions.limits.boom,
      );
      p.stick = clamp(
        p.stick + axis('stickOut', 'stickIn') * 0.017 * availableTorque,
        ...machineDimensions.limits.stick,
      );
      p.curl = clamp(p.curl + curlInput, ...machineDimensions.limits.curl);
    }
    const wantedSlew = axis('left', 'right') * 0.96;
    slewRate += clamp(wantedSlew - slewRate, -1.12 * step, 1.12 * step);
    p.yaw += slewRate * step;
    driveInput = axis('driveForward', 'driveBack');
    steerInput = axis('steerLeft', 'steerRight');
  }
  function updateMachine() {
    const { x, y, z } = chassis.position;
    trackMoved =
      Math.hypot(x - base.x, z - base.z) > 1e-7 ||
      Math.abs(angleDelta(trackYaw, chassis.angles.y)) > 1e-7;
    base.x = x;
    base.y = y;
    base.z = z;
    trackYaw = chassis.angles.y;
    const { z: rise, x: roll } = chassis.angles;
    const [left, right] = chassis.odometer;
    travel = (left + right) / 2;
    const beltTurn = (right - left) / 2.18;
    const load = core.world_load(w) / capacity;
    const key = [
      p.boom,
      p.stick,
      p.curl,
      p.yaw,
      load,
      travel,
      beltTurn,
      trackYaw,
      base.x,
      base.y,
      base.z,
      rise,
      roll,
    ];
    if (key.every((n, i) => n === previousJointState[i])) return;
    previousJointState = key;
    if (trackMoved) {
      const dx = base.x - rig.root.position.x,
        dz = base.z - rig.root.position.z;
      controls.target.x += dx;
      controls.target.z += dz;
      camera.position.x += dx;
      camera.position.z += dz;
      const dy = base.y - rig.root.position.y;
      controls.target.y += dy;
      camera.position.y += dy;
    }
    rig.root.position.set(base.x, base.y, base.z);
    rig.root.rotation.order = 'YXZ';
    rig.root.quaternion.copy(chassis.rotation);
    rig.root.updateMatrix();
    terrain.trackPose(rig.root.matrix);
    rig.pose({ ...p, load, travel, turn: beltTurn });
    renderer.shadowMap.needsUpdate = true;
    rig.tip.getWorldPosition(tip);
  }
  function tick() {
    const prev = forward(p);
    const previousPose = { ...p };
    trackMoved = false;
    if (sequence.length) animateArm();
    driveInput = steerInput = 0;
    if (manual) moveManual();
    else slewRate = 0;
    protectTool(previousPose);
    if (dragTarget) {
      const achieved = forward(p);
      poseError = Math.hypot(achieved.r - dragTarget.r, achieved.h - dragTarget.h);
      targetMarker.material.color.setHex(poseError > 0.15 || contactStop ? 0xf07b46 : 0xb4e47c);
    }
    const bodyStart = performance.now();
    chassis.step(p, core.world_load(w) / units, driveInput, steerInput, sampleDrive, yardClearance);
    drove ||= !!(driveInput || steerInput);
    chassisMs += performance.now() - bodyStart;
    updateMachine();
    const { pitch, yaw } = toolAttitude(rig.bucket.matrixWorld.elements);
    const now = performance.now();
    if (frame % 4 === 0 && !chassis.asleep) {
      let events = null;
      for (const pad of chassis.patches) {
        if (pad.soil < 0.005 || pad.normalLoad < 0.56) continue;
        const kpa = pad.normalLoad / (0.405 * 0.34);
        core.world_press_shoe(w, pad.world.x, pad.world.z, trackYaw, kpa, pad.slip, pad.side);
        if (frame < 3600) {
          events ??= [];
          events.push(pad.world.x, pad.world.z, trackYaw, kpa, pad.slip, pad.side);
        }
      }
      if (events) shoeEvents[frame] = new Float32Array(events);
    }
    core.world_tool(w, tip.x, tip.y, tip.z, yaw, pitch);
    core.world_tick(w);
    simMs += performance.now() - now;
    renderTicks++;
    const penetration = Math.max(0, core.world_ground(w, tip.x, tip.z) - tip.y);
    availableTorque =
      1 /
      (1 +
        0.48 * Math.min(1.2, penetration) +
        (0.17 * core.world_load(w)) / capacity +
        Math.min(2, chassis.bucketForce / 105));
    visits = core.world_visited(w) * 2;
    clock += step;
    maxLoad = Math.max(maxLoad, core.world_load(w));
    if (frame < 3600) {
      const j = frame * 5;
      replay[j] = tip.x;
      replay[j + 1] = tip.y;
      replay[j + 2] = tip.z;
      replay[j + 3] = yaw;
      replay[j + 4] = pitch;
      if (action || manual) savedMotion++;
    }
    frame++;
    if (trackMoved || frame === 1)
      treads.update(base.x, base.z, trackYaw, ground, (x, z) => {
        return chassis.patches.some(
          (pad) =>
            pad.normalLoad > 0.75 &&
            pad.n.axis.y > 0.2 &&
            (pad.world.x - x) ** 2 + (pad.world.z - z) ** 2 < 0.52 ** 2,
        );
      });
    const moving =
      Math.abs(prev.pitch - pitch) +
      Math.abs(prev.r - forward(p).r) +
      Math.abs(angleDelta(prev.yaw, p.yaw));
    if (sound) sound.move(moving);
  }
  function hud() {
    markMass = massHere();
    const qty = Math.max(0, markMass - targetBase);
    byId('delivered').textContent = fmt(job === 2 ? core.world_bay(w) : qty);
    byId('bucketFill').textContent = fmt(core.world_load(w));
    if (sideView && dragTarget) {
      note(
        (contactStop ? 'Hard contact. ' : '') +
          'Teeth ' +
          poseError.toFixed(2) +
          ' m from cursor. Lip ' +
          Math.round((forward(p).pitch * 180) / Math.PI) +
          '°.',
      );
    }
    byId('simTime').textContent = (simMs / Math.max(1, renderTicks)).toFixed(3) + ' ms';
    byId('visited').textContent = visits.toLocaleString() + ' / 65,536';
    if (!byId('lab').hidden) {
      byId('massError').textContent = core.world_balance(w) + ' units';
      byId('upload').textContent = (uploadBytes / 1024).toFixed(1) + ' KiB';
      byId('meshTime').textContent = terrainMs.toFixed(2) + ' ms';
      const body = chassis.state();
      byId('trackLoad').textContent =
        body.leftLoadKN.toFixed(0) + ' / ' + body.rightLoadKN.toFixed(0) + ' kN';
      byId('chassisTime').textContent = (chassisMs / Math.max(1, renderTicks)).toFixed(3) + ' ms';
      byId('travelSpeed').textContent = (body.speed * 3.6).toFixed(1) + ' km/h';
      byId('machineMass').textContent = (body.massKg / 1000).toFixed(2) + ' t';
      byId('draws').textContent = String(renderer.info.render.calls);
    }
    byId('fps').textContent = Math.round(fps) + ' fps';
    if (!done && job < 2 && qty / units >= goal() && !core.world_air_len(w) && !action) {
      done = true;
      byId('nextJob').hidden = false;
      byId('nextJob').textContent = job === 0 ? 'Next order' : 'Free dig';
      note(
        'Order complete in ' + Math.floor(clock - orderTime) + ' s. ' + fmt(qty) + ' delivered.',
      );
    }
  }
  async function compare() {
    if (busy) return;
    const before = paused;
    setPause(true);
    busy = true;
    byId('bench').disabled = true;
    let sparse = 0,
      dense = 0;
    try {
      const scenario = byId('scenario').value;
      const avalanche = scenario === 'avalanche',
        make = avalanche ? core.avalanche_new : core.world_new;
      sparse = make(0);
      dense = make(1);
      const actual = scenario === 'player' && savedMotion > 30 && (maxLoad > 100 || drove);
      const frames = actual ? Math.min(frame, 3600) : avalanche ? 360 : 720;
      const times = [0, 0],
        pairs = [0, 0],
        handles = [sparse, dense];
      let maxDelta = 0;
      for (let i = 0; i < frames; i += 60) {
        const end = Math.min(i + 60, frames);
        for (let pass = 0; pass < 2; pass++) {
          const h = (pass + Math.floor(i / 60)) % 2,
            handle = handles[h];
          const begin = performance.now();
          for (let f = i; f < end; f++) {
            if (actual) {
              const j = f * 5;
              const events = shoeEvents[f];
              if (events)
                for (let n = 0; n < events.length; n += 6) {
                  core.world_press_shoe(
                    handle,
                    events[n],
                    events[n + 1],
                    events[n + 2],
                    events[n + 3],
                    events[n + 4],
                    events[n + 5],
                  );
                }
              core.world_tool(
                handle,
                replay[j],
                replay[j + 1],
                replay[j + 2],
                replay[j + 3],
                replay[j + 4],
              );
              core.world_tick(handle);
            } else if (avalanche) core.world_tick(handle);
            else core.replay_step(handle, f);
            pairs[h] += core.world_visited(handle);
          }
          times[h] += performance.now() - begin;
        }
        maxDelta = Math.max(
          maxDelta,
          Math.abs(core.world_balance(sparse)),
          Math.abs(core.world_balance(dense)),
        );
        byId('benchResult').textContent = 'Replaying ' + end + ' / ' + frames + ' ticks…';
        await new Promise(requestAnimationFrame);
      }
      const equal = core.world_hash(sparse) === core.world_hash(dense);
      const liveMatch =
        actual && frame <= 3600 ? core.world_hash(sparse) === core.world_hash(w) : null;
      const result = {
        source: actual ? 'Your dig' : avalanche ? 'Quarry-wide avalanche' : 'Reference dig',
        ticks: frames,
        sparseMs: times[0],
        denseMs: times[1],
        pairs,
        match: equal,
        liveMatch,
        massError: maxDelta,
      };
      window.sandLab.lastBenchmark = result;
      byId('benchResult').textContent =
        result.source +
        ' · ' +
        frames +
        ' ticks\nSparse ' +
        times[0].toFixed(1) +
        ' ms / dense ' +
        times[1].toFixed(1) +
        ' ms\n' +
        pairs[0].toLocaleString() +
        ' / ' +
        pairs[1].toLocaleString() +
        ' pairs\n' +
        (equal ? 'Matching final state' : 'State mismatch') +
        ' · mass error ' +
        maxDelta;
    } finally {
      if (sparse) core.world_drop(sparse);
      if (dense) core.world_drop(dense);
      busy = false;
      byId('bench').disabled = false;
      setPause(before);
      if (pendingReset) {
        pendingReset = false;
        reset();
      }
    }
  }
  function audioToggle() {
    if (sound) {
      sound.ctx.close();
      sound = null;
      byId('audio').textContent = 'Sound off';
      return;
    }
    const ctx = new AudioContext(),
      motor = ctx.createOscillator(),
      gain = ctx.createGain(),
      filter = ctx.createBiquadFilter();
    motor.type = 'sawtooth';
    motor.frequency.value = 43;
    filter.type = 'lowpass';
    filter.frequency.value = 145;
    gain.gain.value = 0.035;
    motor.connect(filter).connect(gain).connect(ctx.destination);
    motor.start();
    ctx.resume();
    sound = {
      ctx,
      move: (n) =>
        motor.frequency.setTargetAtTime(43 + Math.min(24, n * 300), ctx.currentTime, 0.12),
    };
    byId('audio').textContent = 'Sound on';
  }
  document
    .querySelectorAll('[data-action]')
    .forEach((e) => (e.onclick = () => queue(e.dataset.action)));
  document.querySelectorAll('[data-hold]').forEach((e) => {
    e.onpointerdown = (event) => {
      event.preventDefault();
      sequence = [];
      e.setPointerCapture(event.pointerId);
      pointerHeld.set(event.pointerId, e.dataset.hold);
    };
    e.onlostpointercapture =
      e.onpointercancel =
      e.onpointerup =
        (event) => pointerHeld.delete(event.pointerId);
  });
  byId('helpToggle').onclick = () => togglePanels('help');
  byId('labToggle').onclick = () => togglePanels('lab');
  byId('forces').onclick = () =>
    byId('forces').setAttribute('aria-pressed', String(contactView.toggle()));
  byId('tiles').onclick = () => {
    const on = byId('tiles').getAttribute('aria-pressed') !== 'true';
    byId('tiles').setAttribute('aria-pressed', String(on));
    terrain.inspect(on);
  };
  byId('manual').onclick = () => setManual(!manual);
  byId('cutView').onclick = toggleCutView;
  function endDrag() {
    dragTarget = null;
    dragId = null;
    targetMarker.visible = false;
    if (sideView) note('Drag to place the teeth. Hold R to curl or F to tip.');
  }
  function toggleCutView() {
    sideView = !sideView;
    endDrag();
    controls.enabled = !sideView;
    const b = byId('cutView');
    b.setAttribute('aria-pressed', String(sideView));
    b.textContent = sideView ? 'Orbit view' : 'Cut view';
    if (sideView) {
      orbitOffset.copy(camera.position).sub(controls.target);
      setManual(true);
      note('Drag in the cut plane to guide the teeth. R curls the bucket and F tips it.');
      frameCutView();
    } else {
      controls.target.set(base.x + 1.15, base.y + 1.5, base.z + 0.9);
      camera.position.copy(controls.target).add(orbitOffset);
      controls.update();
      note('Hold a control to move. Double-click the ground to position the teeth.');
    }
  }
  function frameCutView() {
    const yaw = p.yaw + trackYaw,
      c = Math.cos(yaw),
      s = Math.sin(yaw);
    const distance = 13.6 * framing;
    controls.target.set(base.x + 2.25 * c, base.y + 2.1, base.z - 2.25 * s);
    camera.position.set(
      controls.target.x + distance * s,
      controls.target.y + distance * 0.09,
      controls.target.z + distance * c,
    );
    camera.lookAt(controls.target);
    camera.updateMatrixWorld();
  }
  function aimDrag(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    cast.setFromCamera(
      {
        x: (2 * (ev.clientX - rect.left)) / rect.width - 1,
        y: 1 - (2 * (ev.clientY - rect.top)) / rect.height,
      },
      camera,
    );
    const localAxis = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw)).transformDirection(
      rig.root.matrixWorld,
    );
    armPlane.setFromNormalAndCoplanarPoint(localAxis, rig.root.position);
    if (!cast.ray.intersectPlane(armPlane, touchPoint)) return;
    targetMarker.position.copy(touchPoint);
    targetMarker.quaternion.copy(camera.quaternion);
    targetMarker.visible = true;
    const local = rig.root.worldToLocal(touchPoint.clone());
    dragTarget = {
      r: local.x * Math.cos(p.yaw) - local.z * Math.sin(p.yaw),
      h: local.y,
      pitch: dragTarget?.pitch ?? forward(p).pitch,
    };
  }
  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', (ev) => {
    if (!sideView || ev.button !== 0 || busy || paused || dragId !== null) return;
    ev.preventDefault();
    if (!manual) setManual(true);
    sequence = [];
    action = '';
    select('');
    dragId = ev.pointerId;
    canvas.setPointerCapture(dragId);
    aimDrag(ev);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (ev.pointerId === dragId) aimDrag(ev);
  });
  canvas.addEventListener('lostpointercapture', (ev) => {
    if (ev.pointerId === dragId) endDrag();
  });
  byId('bench').onclick = compare;
  byId('pause').onclick = () => {
    if (!busy) setPause(!paused);
  };
  byId('step').onclick = () => {
    if (paused && !busy) {
      tick();
      hud();
    }
  };
  byId('reset').onclick = reset;
  byId('nextJob').onclick = nextJob;
  byId('audio').onclick = audioToggle;
  byId('offline').onclick = () => {
    const url = URL.createObjectURL(new Blob([offlineSource], { type: 'text/html;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'SandLab.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
    if (ev.code === 'Escape') {
      byId('help').hidden = byId('lab').hidden = true;
      byId('helpToggle').setAttribute('aria-expanded', 'false');
      byId('labToggle').setAttribute('aria-expanded', 'false');
      return;
    }
    if (keyMap[ev.code]) {
      ev.preventDefault();
      if (!manual) setManual(true);
      sequence = [];
      keyHeld.add(keyMap[ev.code]);
    }
    if (!ev.repeat && /^Digit[1-4]$/.test(ev.code))
      queue(['dig', 'lift', 'swing', 'dump'][Number(ev.code.slice(-1)) - 1]);
  });
  document.addEventListener('keyup', (ev) => keyHeld.delete(keyMap[ev.code]));
  const inputsOff = () => {
    endDrag();
    keyHeld.clear();
    pointerHeld.clear();
    accum = 0;
    lastNow = 0;
  };
  window.addEventListener('blur', inputsOff);
  document.addEventListener('visibilitychange', inputsOff);
  byId('view').addEventListener('dblclick', (ev) => {
    if (sideView) return;
    if (!manual) setManual(true);
    const rect = byId('view').getBoundingClientRect(),
      cast = new THREE.Raycaster();
    cast.setFromCamera(
      new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        1 - ((ev.clientY - rect.top) / rect.height) * 2,
      ),
      camera,
    );
    const hit = new THREE.Vector3();
    for (let d = 0.25; d < 60; d += 0.075) {
      cast.ray.at(d, hit);
      if (hit.y > core.world_ground(w, hit.x, hit.z)) continue;
      const aim = aimed(hit);
      sequence = [{ ...aim, pitch: -0.6, ticks: 65 }];
      note('Positioning the cutting edge. Hold Curl to take a bite.');
      break;
    }
  });
  window.sandLab = {
    state: () => ({
      frame,
      load: core.world_load(w),
      bay: core.world_bay(w),
      massError: core.world_balance(w),
      air: core.world_air_len(w),
      visits,
      job,
      done,
      action,
      manual,
      paused,
      tip: tip.toArray(),
      pose: { ...p },
      toolPitch: forward(p).pitch,
      ikError: poseError,
      hardContact: contactStop,
      cutView: sideView,
      base: { ...base },
      chassis: chassis.state(),
      trackYaw,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      fps,
      simMsPerTick: simMs / Math.max(1, renderTicks),
      maxLoad,
      markMass,
      selected,
    }),
    lastBenchmark: null,
  };
  reset();
  window.addEventListener('resize', () => resize());
  let sinceHud = 0;
  function display(ms) {
    const wallTime = lastNow ? (ms - lastNow) / 1000 : step,
      dt = Math.min(0.12, wallTime);
    lastNow = ms;
    if (!paused) {
      accum += dt;
      let n = 0;
      while (accum >= step && n++ < 6) {
        tick();
        accum -= step;
      }
      if (accum > step * 2) accum = step;
    }
    const updateStart = performance.now();
    uploadBytes = terrain.sync(core, w);
    terrainMs = performance.now() - updateStart;
    stream(core, w);
    if (uploadBytes) {
      renderer.shadowMap.needsUpdate = true;
      treads.refresh((x, z) => core.world_ground(w, x, z));
    }
    if (sideView) frameCutView();
    else controls.update();
    contactView.update(ground);
    renderer.render(scene, camera);
    frameSum += wallTime;
    frameCount++;
    sinceHud += dt;
    if (sinceHud >= 0.25) {
      fps = frameCount / frameSum;
      hud();
      sinceHud = 0;
      simMs = chassisMs = 0;
      renderTicks = 0;
      frameSum = 0;
      frameCount = 0;
    }
    requestAnimationFrame(display);
  }
  requestAnimationFrame(display);
}
start().catch((error) => {
  console.error(error);
  note('Could not start SandLab. ' + error.message + ' · This game needs WebGL2 and WebAssembly.');
});
