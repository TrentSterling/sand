import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { carrierClearance, createMachine, machineDimensions } from './machine.js';
import { armIK, forward, toolAttitude } from './arm.js';
import { createExit, escapeYard, newEscapeWorld, parkOnDeck } from './escape.js';
import { createCrawler } from './crawler.js';
import { driveGround, yardClearance, escapeClearance, haulClearance } from './drive-ground.js';
import {
  positionTruckWalls,
  truckHulls,
  clearTruckReactions,
  checkDispatchLane,
  truckInputs,
} from './truck-contact.js';
import { fleet, createFleet, addTruckBeds } from './trucks.js';
import { createLooseProps } from './props.js';
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
  const quarry = createQuarry(THREE, scene);
  const terrain = createGround(scene),
    stream = createStream(scene),
    rig = createMachine(THREE),
    treads = createTreads(THREE, scene);
  scene.add(rig.root);
  const chassis = createCrawler();
  const exit = createExit(scene);
  const yardProps = createLooseProps(scene, exit);
  let trucks = null;
  const truckOffsets = new Float32Array(fleet.length);
  const placeTarget = new THREE.Mesh(
    new THREE.RingGeometry(0.23, 0.3, 36),
    new THREE.MeshBasicMaterial({
      color: 0xffc24a,
      side: THREE.DoubleSide,
      depthTest: false,
      transparent: true,
      opacity: 0.92,
    }),
  );
  placeTarget.rotation.x = -Math.PI / 2;
  placeTarget.renderOrder = 4;
  scene.add(placeTarget);
  const rampLeft = { x: escapeYard.lip - 0.49, z: -1.08 },
    rampRight = { x: escapeYard.lip - 0.49, z: 1.08 };
  const requestedYard = new URLSearchParams(location.search).get('yard');
  let yard = ['quarry', 'haul', 'dunes'].includes(requestedYard) ? requestedYard : 'escape';
  let escapeMode = yard === 'escape',
    deckReached = false;
  function createWorld(dense) {
    if (escapeMode) return newEscapeWorld(core, dense);
    if (yard === 'dunes') return core.dunes_new(dense);
    const handle = yard === 'haul' ? core.haul_new(dense) : core.world_new(dense);
    if (yard === 'haul') addTruckBeds(core, handle);
    return handle;
  }
  let scoops = 0,
    tookLoad = false,
    startFrame = null,
    parkTicks = 0,
    finishTime = 0;
  let aimedDrop = null,
    markerSpot = null,
    stallTicks = 0,
    brakingOnDeck = false;
  const brief = 'Build a ramp. Park on the flagged deck or drive through the gate.';
  let splitNext = false,
    stallSide = '';
  const bestKey = 'sandlab.escape.v1';
  function bestRun() {
    try {
      const r = JSON.parse(localStorage.getItem(bestKey));
      return r && Number.isInteger(r.scoops) && Number.isFinite(r.seconds) ? r : null;
    } catch {
      return null;
    }
  }
  function laneHeight(spot) {
    // Average across the grouser width immediately before the concrete.
    let sum = 0;
    for (const dx of [0.1, 0.27])
      for (const dz of [-0.24, 0, 0.24]) sum += ground(escapeYard.lip - dx, spot.z + dz);
    return sum / 6;
  }
  function startRun() {
    if (escapeMode && startFrame === null && !done) startFrame = frame;
  }
  function finishEscape() {
    exit.clearMarks();
    stallSide = '';
    done = true;
    finishTime = Math.max(1, Math.round((frame - (startFrame ?? 0)) / 60));
    const past = bestRun();
    const best =
      !past || scoops < past.scoops || (scoops === past.scoops && finishTime < past.seconds);
    if (best) {
      try {
        localStorage.setItem(bestKey, JSON.stringify({ scoops, seconds: finishTime }));
      } catch {}
    }
    byId('goal').textContent = 'You made it out.';
    byId('missionBrief').textContent =
      scoops + ' scoop' + (scoops === 1 ? '' : 's') + ' in ' + finishTime + ' s.';
    byId('finishResult').textContent = best
      ? 'Personal best'
      : 'Best: ' + past.scoops + ' scoops in ' + past.seconds + ' s';
    byId('finishResult').hidden = false;
    byId('nextJob').textContent = 'Load the trucks';
    byId('nextJob').hidden = false;
    byId('retry').hidden = false;
    note(yardProps.broken ? 'You made it. The gate has resigned.' : 'Both tracks made it out.');
  }
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
    const clearance = (pose) =>
      yard === 'haul'
        ? Math.min(
            carrierClearance(pose),
            truckHulls(pose, chassis.position, chassis.rotation, null, 0.015),
          )
        : carrierClearance(pose);
    const margin = clearance(p);
    if (margin >= 0 || margin >= clearance(old)) return;
    const goal = { ...p };
    let good = 0,
      bad = 1;
    const floor = Math.min(0, clearance(old));
    for (let i = 0; i < 9; i++) {
      const t = (good + bad) / 2;
      for (const joint of ['boom', 'stick', 'curl', 'yaw'])
        p[joint] = mix(old[joint], goal[joint], t);
      if (clearance(p) >= floor) good = t;
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
  const recoverFrames = new Set();
  const truckEvents = Array(3600).fill(null);
  function applyTruckInputs(handle, events) {
    for (let i = 0; i < fleet.length; i++) {
      const offset = i * 4;
      core.world_truck_contact(
        handle,
        i,
        events?.[offset] ?? 0,
        events?.[offset + 1] ?? 0,
        events?.[offset + 2] ?? 0,
        events?.[offset + 3] ?? 0,
      );
    }
  }
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
  const destination = () =>
    yard === 'haul'
      ? { x: fleet[job].x + core.world_truck_offset(w, job), z: fleet[job].z }
      : job === 1
        ? berm
        : bay;
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
  const massHere = () =>
    yard === 'haul' ? core.world_truck_load(w, job) : job === 1 ? markAmount() : core.world_bay(w);
  const goal = () => (yard === 'haul' ? fleet[job].order : job === 0 ? 0.75 : 1.5);
  const targetText = () =>
    escapeMode
      ? 'Build your way out'
      : yard === 'haul'
        ? 'Load ' + fleet[job].name + ' · ' + fleet[job].order.toFixed(2) + ' m³'
        : yard === 'dunes'
          ? 'Dune field · free dig'
          : job === 0
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
      controls.target.set(
        escapeMode ? 3.2 : 1.15,
        escapeMode ? 0.95 : 1.5,
        escapeMode ? -0.7 : 0.9,
      );
      camera.position
        .copy(controls.target)
        .add(
          (escapeMode
            ? new THREE.Vector3(-2.4, 9.3, 16.3)
            : new THREE.Vector3(8.7, 6.5, 12.3)
          ).multiplyScalar(factor),
        );
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
    byId('assistPanel').hidden = on || escapeMode;
    byId('rampPanel').hidden = on || !escapeMode;
    aimedDrop = null;
    markerSpot = null;
    placeTarget.visible = false;
    splitNext = false;
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
        : escapeMode
          ? 'Tap the bank to scoop. With a load, tap where you want it.'
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
    w = createWorld(0);
    if (yard === 'haul' && !trucks) trucks = createFleet(scene);
    if (yard === 'haul') positionTruckWalls(core, w);
    if (trucks) {
      trucks.group.visible = yard === 'haul';
      trucks.reset();
    }
    quarry.bayGroup.visible = yard !== 'haul';
    exit.group.visible = escapeMode;
    exit.reset();
    yardProps.reset(ground);
    deckReached = false;
    terrain.reset(escapeMode);
    sampleDrive = driveGround(core, w, escapeMode);
    recoverFrames.clear();
    shoeEvents.fill(null);
    truckEvents.fill(null);
    drove = false;
    base = { x: 0, y: 0, z: 0 };
    trackYaw = 0;
    travel = 0;
    job = escapeMode ? -1 : yard === 'dunes' ? 2 : 0;
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
    scoops = 0;
    tookLoad = false;
    parkTicks = 0;
    startFrame = null;
    finishTime = 0;
    stallTicks = 0;
    brakingOnDeck = false;
    const best = escapeMode && bestRun();
    byId('finishResult').hidden = !best;
    byId('retry').hidden = true;
    if (best)
      byId('finishResult').textContent =
        'Best: ' + best.scoops + ' scoops in ' + best.seconds + ' s';
    byId('quantityLabel').textContent = escapeMode
      ? 'Scoops'
      : yard === 'haul'
        ? 'Truck payload'
        : yard === 'dunes'
          ? 'Sand on site'
          : 'Delivered';
    byId('missionBrief').hidden = yard === 'quarry';
    stallSide = '';
    byId('missionBrief').textContent = escapeMode
      ? brief
      : yard === 'haul'
        ? 'Pick up a load, swing above the red tipper, then dump into its open bed.'
        : 'Dig anywhere. Open CPU lab to stress the dunes with repeated landslides.';
    byId('yardGuide').textContent = escapeMode
      ? 'Tap the bank for a bucketful, then tap the ground to place it. Choose Half pour to save sand for a second spot. An orange cross marks where a track stalled.'
      : yard === 'haul'
        ? 'Use Dig, Lift, Swing and Dump to load each waiting truck. Land sand inside the bed to earn payload.'
        : yard === 'dunes'
          ? 'Explore the dunes, or compare both soil schedulers under repeated landslides in the CPU lab.'
          : 'Dig into the bank, lift, swing to the weigh bay and dump. Complete both orders to unlock free dig.';
    for (const [id, name] of Object.entries({
      escapeJob: 'escape',
      switchYard: 'quarry',
      truckJob: 'haul',
      duneJob: 'dunes',
    }))
      byId(id).disabled = yard === name;
    byId('scenario').value = yard === 'dunes' ? 'dunes' : 'player';
    window.sandLab.lastBenchmark = null;
    p = { ...armIK(5.82, 2.65, -0.74), yaw: 0 };
    if (escapeMode) p.yaw = -Math.atan2(escapeYard.bank.z, escapeYard.bank.x);
    chassis.reset(p, 0);
    slewRate = 0;
    driveInput = steerInput = 0;
    setManual(false);
    setPause(false);
    byId('nextJob').hidden = true;
    byId('goal').textContent = targetText();
    byId('benchResult').textContent = '';
    note(
      escapeMode
        ? 'Tap the sand bank to take a bite, or press Scoop bank.'
        : 'Take a bite from the bank. Start with Dig.',
    );
    updateMachine();
    terrain.sync(core, w);
    stream(core, w);
    hud();
    resize(true);
  }
  function nextJob() {
    if (busy || !done || job >= 2) return;
    if (escapeMode) {
      switchYard('haul');
      return;
    }
    if (yard === 'haul') {
      if (job === 1) {
        switchYard('dunes');
        return;
      }
      job = 1;
      done = false;
      byId('nextJob').hidden = true;
      byId('goal').textContent = targetText();
      byId('missionBrief').textContent =
        'Swing around to the teal six-wheeler. Its order is ' + goal().toFixed(2) + ' m³.';
      note('Mule Six is next. Mind the mirrors.');
      hud();
      return;
    }
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
  function switchYard(name) {
    if (busy) return;
    yard = name;
    escapeMode = yard === 'escape';
    if (location.protocol === 'https:' || location.protocol === 'http:') {
      const url = new URL(location.href);
      if (escapeMode) url.searchParams.delete('yard');
      else url.searchParams.set('yard', yard);
      history.replaceState(null, '', url);
    }
    byId('help').hidden = byId('lab').hidden = true;
    for (const name of ['help', 'lab'])
      byId(name + 'Toggle').setAttribute('aria-expanded', 'false');
    reset();
  }
  function aimed(target) {
    const local = rig.root.worldToLocal(
      new THREE.Vector3(target.x, target.y ?? ground(target.x, target.z), target.z),
    );
    return { r: Math.hypot(local.x, local.z), h: local.y, yaw: -Math.atan2(local.z, local.x) };
  }
  function queue(name, cut = source, drop = destination()) {
    if (busy) return;
    if (manual) setManual(false);
    if (paused) setPause(false);
    const start = forward(p),
      dest = aimed(drop);
    const make = (r, h, pitch, yaw, ticks) => ({ r, h, pitch, yaw, ticks });
    let goals;
    switch (name) {
      case 'dig': {
        const angle = Math.atan2(cut.z - base.z, cut.x - base.x);
        const radial = Math.hypot(cut.x - base.x, cut.z - base.z);
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
      case 'swing': {
        const clearance = yard === 'haul' ? 4.25 : 2.65;
        goals = [
          make(start.r, Math.max(start.h, clearance), 0.44, start.yaw, yard === 'haul' ? 68 : 32),
          make(
            dest.r,
            clearance,
            0.44,
            dest.yaw,
            Math.max(100, Math.ceil(Math.abs(angleDelta(start.yaw, dest.yaw)) * dest.r * 22)),
          ),
        ];
        if (yard === 'haul') goals.push(make(dest.r, fleet[job].floor + 1.45, 0.44, dest.yaw, 55));
        note(
          escapeMode
            ? 'Carrying the load to your mark.'
            : yard === 'haul'
              ? 'Swinging over ' + fleet[job].name + '.'
              : job === 1
                ? 'Slewing to the stockpile ring.'
                : 'Slewing to the weigh bay.',
        );
        break;
      }
      case 'dump': {
        const splitting = escapeMode && splitNext;
        const angle = splitting ? core.half_pour_pitch(core.world_load(w)) : -1.22;
        splitNext = false;
        goals = [
          make(start.r, start.h, angle, start.yaw, 51),
          make(start.r, start.h, angle, start.yaw, 32),
        ];
        if (splitting) goals.push(make(start.r, start.h, 0.44, start.yaw, 40));
        note(
          splitting
            ? 'Metering sand over the lip.'
            : escapeMode
              ? 'Tipping onto the approach.'
              : 'Opening the bucket. The load scores where it lands.',
        );
        break;
      }
      default:
        return;
    }
    sequence = goals;
    action = name;
    select(name);
  }
  function commandGround(target, drop) {
    if (busy || done || !escapeMode || action) return;
    if (manual) setManual(false);
    const load = core.world_load(w);
    if (drop && load < 180) {
      note('Take a bite from the bank first.');
      return;
    }
    if (!drop && load >= 180) {
      note('Place the sand in the bucket first.');
      return;
    }
    const aim = aimed(target);
    if (aim.r < 2.15) {
      note('Too close to the tracks. Reverse to give the bucket room.');
      return;
    }
    if (aim.r > 7.55) {
      note('Out of reach. Drive closer, or choose another spot.');
      return;
    }
    if (!drop && ground(target.x, target.z) < 0.12) {
      note('Aim at loose sand on the bank.');
      return;
    }
    startRun();
    markerSpot = { x: target.x, z: target.z };
    placeTarget.visible = true;
    placeTarget.material.color.setHex(drop ? 0xffab38 : 0x9ef6da);
    aimedDrop = drop ? markerSpot : null;
    if (drop) queue('swing', source, target);
    else queue('dig', target);
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
        if (escapeMode && action === 'swing' && aimedDrop) {
          const target = aimedDrop;
          aimedDrop = null;
          queue('dump', source, target);
          return;
        }
        if (action === 'dig')
          note(
            load > 500
              ? escapeMode
                ? fmt(load) + ' in the bucket. Tap where you want it.'
                : 'Load caught. Lift it clear of the bank.'
              : 'Shallow cut. Move closer or lower the teeth in manual mode.',
          );
        if (action === 'lift') note('Bucket up. Swing to the delivery point.');
        if (action === 'swing') note('Over the target. Dump when ready.');
        if (action === 'dump' && !done) {
          if (escapeMode && stallSide)
            byId('missionBrief').textContent =
              'Test the repaired approach. Park on the deck or drive through the gate.';
          note(
            escapeMode
              ? load >= 180
                ? fmt(load) + ' left. Pick a spot for the rest.'
                : 'Hold Drive to exit to test the ramp, or scoop again.'
              : 'Load released. Dig again for another pass.',
          );
        }
        if (
          (poseError > 0.1 || contactStop) &&
          !(escapeMode && (action === 'dump' || (action === 'dig' && load > 500)))
        )
          note(
            contactStop
              ? 'Tool at hard contact. Raise the boom or draw the stick back.'
              : 'Joint stop reached. Choose a closer point or reposition the tracks.',
          );
        action = '';
        markerSpot = null;
        placeTarget.visible = false;
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
  const arrowCaps = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  for (const [code, action] of Object.entries(keyMap)) {
    const button = byId('manualPanel').querySelector(`[data-hold="${action}"]`);
    const key = code.replace(/^Key/, '');
    const cap = document.createElement('kbd');
    cap.textContent = arrowCaps[code] ?? key;
    cap.setAttribute('aria-hidden', 'true');
    button.setAttribute('aria-keyshortcuts', key);
    button.title = 'Hold ' + key.replace(/^Arrow(.+)$/, '$1 Arrow');
    button.append(cap);
  }
  function held(key) {
    if (keyHeld.has(key)) return true;
    for (const value of pointerHeld.values()) if (value === key) return true;
    return false;
  }
  const axis = (a, b) => Number(held(a)) - Number(held(b));
  function moveManual() {
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
    const previousX = base.x;
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
    if (manual || escapeMode) {
      driveInput = axis('driveForward', 'driveBack');
      steerInput = axis('steerLeft', 'steerRight');
    }
    if (escapeMode && !manual && driveInput > 0 && !steerInput) {
      const heading = Math.atan2(base.z, 1.5);
      steerInput = clamp(angleDelta(trackYaw, heading) * 3.6, -0.75, 0.75);
    }
    if (!held('driveForward')) brakingOnDeck = false;
    if (escapeMode && !manual && driveInput > 0 && (brakingOnDeck || (!done && parkTicks > 0))) {
      brakingOnDeck = true;
      driveInput = steerInput = 0;
    }
    if (driveInput || steerInput) startRun();
    if (yard === 'haul') clearTruckReactions();
    chassis.step(
      p,
      core.world_load(w) / units,
      driveInput,
      steerInput,
      sampleDrive,
      escapeMode ? escapeClearance : yard === 'haul' ? haulClearance : yardClearance,
    );
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
    if (yard === 'haul') {
      let events = null;
      for (let i = 0; i < fleet.length; i++) {
        if (
          core.world_truck_load(w, i) >= fleet[i].order * units &&
          Math.abs(truckOffsets[i]) < 5.79
        )
          checkDispatchLane(p, chassis.position, chassis.rotation, i);
        const input = truckInputs(i);
        if (input[0] || input[3]) {
          events ??= new Float32Array(fleet.length * 4);
          events.set(input, i * 4);
        }
      }
      applyTruckInputs(w, events);
      if (frame < 3600) truckEvents[frame] = events;
    }
    core.world_tool(w, tip.x, tip.y, tip.z, yaw, pitch);
    core.world_tick(w);
    const gateWasBroken = yardProps.broken,
      oldHits = yardProps.hits;
    if (yard === 'haul')
      for (let i = 0; i < fleet.length; i++) truckOffsets[i] = core.world_truck_offset(w, i);
    if (
      yardProps.tick(
        rig,
        tip,
        ground,
        step,
        escapeMode,
        frame,
        yard === 'haul' ? truckOffsets : null,
      )
    )
      renderer.shadowMap.needsUpdate = true;
    if (!gateWasBroken && yardProps.broken) {
      note('Gate inspection complete. Replacement required.');
      playSignal('snap');
    } else if (yardProps.hits > oldHits) playSignal('clonk');
    if (yard === 'haul' && trucks.tick(core, w)) {
      positionTruckWalls(core, w);
      renderer.shadowMap.needsUpdate = true;
    }
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
    const carried = core.world_load(w);
    maxLoad = Math.max(maxLoad, carried);
    if (escapeMode && !done) {
      if (carried > 180 && !tookLoad) {
        tookLoad = true;
        scoops++;
        startRun();
      }
      if (carried < 64) tookLoad = false;
      parkTicks = base.x > escapeYard.lip && parkOnDeck(chassis) ? parkTicks + 1 : 0;
      if (parkTicks > 0 && !deckReached) {
        deckReached = true;
        stallSide = '';
        exit.clearMarks();
        byId('missionBrief').textContent =
          'Both tracks aboard. Stop here or drive through the striped gate.';
        note(
          manual
            ? 'Keep driving through the gate, or release travel to park.'
            : 'Both tracks aboard. Braking on the exit deck.',
        );
      }
      if (deckReached && base.x < escapeYard.lip - 2) {
        deckReached = false;
        byId('missionBrief').textContent = brief;
      }
      const crossed =
        previousX < escapeYard.gateX &&
        base.x >= escapeYard.gateX &&
        base.y > escapeYard.height - 0.14 &&
        Math.abs(base.z) < escapeYard.halfWidth - 0.7;
      if (crossed || (parkTicks >= 24 && Math.abs(chassis.speed) < 0.1)) finishEscape();
      stallTicks =
        driveInput > 0 &&
        base.x > escapeYard.lip - 2.45 &&
        base.x < escapeYard.lip &&
        Math.abs(chassis.speed) < 0.16
          ? stallTicks + 1
          : 0;
      if (stallTicks === 40) {
        stallSide = exit.markStall(chassis, ground);
        const hint =
          stallSide === 'both'
            ? 'Both tracks stalled. Reverse and fill the orange crosses.'
            : 'The ' + stallSide + ' track is low. Reverse and fill the orange cross.';
        byId('missionBrief').textContent = hint;
        note(hint);
      }
    }
    if (frame < 3600) {
      const j = frame * 5;
      replay[j] = tip.x;
      replay[j + 1] = tip.y;
      replay[j + 2] = tip.z;
      replay[j + 3] = yaw;
      replay[j + 4] = pitch;
      if (action || manual || driveInput || steerInput) savedMotion++;
    }
    if (escapeMode && done && exit.open(step)) renderer.shadowMap.needsUpdate = true;
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
    byId('delivered').textContent = escapeMode
      ? String(scoops)
      : yard === 'dunes'
        ? Math.round(core.world_initial_m3(w)).toLocaleString() + ' m³'
        : fmt(job === 2 ? core.world_bay(w) : qty);
    byId('rampReadings').hidden = !escapeMode || done;
    if (escapeMode && !done) {
      exit.refreshMarks(ground);
      const left = laneHeight(rampLeft),
        right = laneHeight(rampRight);
      for (const [id, value] of [
        ['leftSand', left],
        ['rightSand', right],
      ]) {
        byId(id).textContent = Math.round(value * 100) + ' cm';
        byId(id).parentElement.style.setProperty(
          '--level',
          Math.min(100, (100 * value) / (escapeYard.height - escapeYard.bevelRise)) + '%',
        );
      }
    }
    if (escapeMode) {
      const loaded = core.world_load(w) >= 180;
      byId('borrow').disabled = done || !!action || loaded;
      byId('placeLeft').disabled = byId('placeRight').disabled = done || !!action || !loaded;
      byId('split').disabled = done || !!action || !loaded;
      byId('split').setAttribute('aria-pressed', String(splitNext));
    }
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
      byId('truckSpringRow').hidden = yard !== 'haul';
      if (yard === 'haul') {
        const i = Math.min(job, 1),
          t = fleet[i];
        const pose = new Float32Array(core.memory.buffer, core.world_truck_pose(w, i), 21);
        const pairs = [2, 1, 0].map((axle) => {
          const j = 9 + axle * 2;
          return [t.heading > 0 ? j : j + 1, t.heading > 0 ? j + 1 : j]
            .map((k) => Math.round(pose[k] * 1000))
            .join('/');
        });
        byId('truckSprings').textContent = pairs.join(' ? ') + ' mm';
      }
      byId('draws').textContent = String(renderer.info.render.calls);
    }
    byId('fps').textContent = Math.round(fps) + ' fps';
    if (
      !escapeMode &&
      !done &&
      job < 2 &&
      qty / units >= goal() &&
      !core.world_air_len(w) &&
      !action
    ) {
      done = true;
      byId('nextJob').hidden = false;
      if (yard === 'haul') {
        byId('goal').textContent = fleet[job].name + ' is loaded.';
        byId('missionBrief').textContent = fmt(qty) + ' landed in the bed.';
        byId('nextJob').textContent = job === 0 ? 'Load Mule Six' : 'Open the dune field';
        note(
          job === 0
            ? 'One honk means thanks. Two means there is sand in the cab.'
            : 'Both loads weighed in. The dispatch radio is finally quiet.',
        );
        playSignal('horn');
        return;
      }
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
      const dunes = scenario === 'dunes';
      const avalanche = scenario === 'avalanche',
        actual = scenario === 'player' && savedMotion > 30 && (maxLoad > 100 || drove),
        make = avalanche
          ? core.avalanche_new
          : dunes
            ? core.dunes_new
            : actual
              ? createWorld
              : core.world_new;
      sparse = make(0);
      dense = make(1);

      const frames = actual ? Math.min(frame, 3600) : dunes ? 900 : avalanche ? 360 : 720;
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
              if (recoverFrames.has(f)) core.world_recover_tool(handle);
              if (yard === 'haul') applyTruckInputs(handle, truckEvents[f]);
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
            } else if (dunes) core.dune_stress_step(handle, f);
            else if (avalanche) core.world_tick(handle);
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
        source: actual
          ? 'Your dig'
          : dunes
            ? 'Dune field stress test'
            : avalanche
              ? 'Quarry-wide avalanche'
              : 'Reference dig',
        initialM3: core.world_initial_m3(sparse),
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
  function playSignal(kind) {
    if (!sound) return;
    const ctx = sound.ctx,
      now = ctx.currentTime;
    for (const delay of kind === 'horn' ? [0, 0.24] : [0]) {
      const osc = ctx.createOscillator(),
        vol = ctx.createGain(),
        at = now + delay;
      osc.type = kind === 'horn' ? 'sawtooth' : 'triangle';
      osc.frequency.setValueAtTime(kind === 'horn' ? 205 : kind === 'snap' ? 640 : 170, at);
      osc.frequency.exponentialRampToValueAtTime(kind === 'horn' ? 192 : 52, at + 0.12);
      vol.gain.setValueAtTime(0.001, at);
      vol.gain.exponentialRampToValueAtTime(0.065, at + 0.007);
      vol.gain.exponentialRampToValueAtTime(0.001, at + 0.17);
      osc.connect(vol).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.18);
      osc.onended = () => {
        osc.disconnect();
        vol.disconnect();
      };
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
      interruptArm();
      startRun();
      e.setPointerCapture(event.pointerId);
      pointerHeld.set(event.pointerId, e.dataset.hold);
    };
    e.onlostpointercapture =
      e.onpointercancel =
      e.onpointerup =
        (event) => pointerHeld.delete(event.pointerId);
  });
  function interruptArm() {
    sequence = [];
    action = '';
    aimedDrop = null;
    markerSpot = null;
    placeTarget.visible = false;
    splitNext = false;
    select('');
  }
  byId('borrow').onclick = () => commandGround(escapeYard.bank, false);
  byId('placeLeft').onclick = () => commandGround(rampLeft, true);
  byId('placeRight').onclick = () => commandGround(rampRight, true);
  byId('split').onclick = () => {
    splitNext = !splitNext;
    hud();
    note(splitNext ? 'Pick the first spot for half the load.' : 'Pick a spot for the full load.');
  };
  byId('retry').onclick = () => reset();
  for (const [id, name] of Object.entries({
    escapeJob: 'escape',
    switchYard: 'quarry',
    truckJob: 'haul',
    duneJob: 'dunes',
  }))
    byId(id).onclick = () => switchYard(name);
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
  byId('recover').onclick = () => {
    if (busy) return;
    setManual(manual);
    p = { ...armIK(4.9, 3.4, 0.48), yaw: 0 };
    let height = ground(0, 0);
    for (const x of [-2, -1, 0, 1, 2])
      for (const z of [-1.3, -1, 1, 1.3]) height = Math.max(height, ground(x, z));
    chassis.reset(p, core.world_load(w) / units, 0, height + 0.03, 0);
    core.world_recover_tool(w);
    yardProps.rebaseColliders();
    if (frame < 3600) recoverFrames.add(frame);
    driveInput = steerInput = slewRate = 0;
    brakingOnDeck = false;
    parkTicks = stallTicks = 0;
    deckReached = false;
    stallSide = '';
    exit.clearMarks();
    if (escapeMode && !done) byId('missionBrief').textContent = brief;
    previousJointState = [];
    updateMachine();
    byId('help').hidden = true;
    byId('helpToggle').setAttribute('aria-expanded', 'false');
    setPause(false);
    note('Back on the starting pad. Your load and job progress are saved for this run.');
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
      if (!manual && !(escapeMode && ev.code.startsWith('Arrow'))) setManual(true);
      interruptArm();
      startRun();
      keyHeld.add(keyMap[ev.code]);
    }
    if (!ev.repeat && /^Digit[1-4]$/.test(ev.code)) {
      const i = Number(ev.code.slice(-1)) - 1;
      if (escapeMode) {
        if (i < 3) commandGround([escapeYard.bank, rampLeft, rampRight][i], i > 0);
      } else queue(['dig', 'lift', 'swing', 'dump'][i]);
    }
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
  function groundPoint(ev) {
    const rect = canvas.getBoundingClientRect();
    cast.setFromCamera(
      {
        x: (2 * (ev.clientX - rect.left)) / rect.width - 1,
        y: 1 - (2 * (ev.clientY - rect.top)) / rect.height,
      },
      camera,
    );
    const hit = new THREE.Vector3();
    for (let d = 0.18; d < 65; d += 0.11) {
      cast.ray.at(d, hit);
      if (Math.abs(hit.x) > 15.95 || Math.abs(hit.z) > 15.95 || hit.y > ground(hit.x, hit.z))
        continue;
      let lo = d - 0.11,
        hi = d;
      for (let k = 0; k < 7; k++) {
        const mid = (lo + hi) / 2;
        cast.ray.at(mid, hit);
        if (hit.y > ground(hit.x, hit.z)) lo = mid;
        else hi = mid;
      }
      return cast.ray.at(hi, hit);
    }
    return null;
  }
  let tap = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0) {
      tap = null;
      return;
    }
    if (escapeMode && !manual && !sideView) tap = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 7) tap = null;
  });
  canvas.addEventListener('pointercancel', () => {
    tap = null;
  });
  canvas.addEventListener('pointerup', (e) => {
    const click = tap;
    tap = null;
    if (!click || click.id !== e.pointerId || busy || paused || manual) return;
    const hit = groundPoint(e);
    if (hit) commandGround(hit, core.world_load(w) >= 180);
  });
  canvas.addEventListener('dblclick', (ev) => {
    if (sideView || busy || (escapeMode && !manual)) return;
    const hit = groundPoint(ev);
    if (!hit) return;
    if (!manual) setManual(true);
    sequence = [{ ...aimed(hit), pitch: -0.6, ticks: 65 }];
    note('Positioning the cutting edge. Hold Curl to take a bite.');
  });
  window.sandLab = {
    state: () => ({
      frame,
      yard,
      gateBroken: yardProps.broken,
      propHits: yardProps.hits,
      initialM3: core.world_initial_m3(w),
      truckLoads: yard === 'haul' ? fleet.map((_, i) => core.world_truck_load(w, i)) : [],
      truckSuspension:
        yard === 'haul'
          ? fleet.map((_, i) =>
              Array.from(new Float32Array(core.memory.buffer, core.world_truck_pose(w, i), 21)),
            )
          : [],
      truckClearance:
        yard === 'haul' ? truckHulls(p, chassis.position, chassis.rotation, null, 0.5) : null,
      truckTravel: yard === 'haul' ? fleet.map((_, i) => core.world_truck_offset(w, i)) : [],
      scoops,
      finishTime,
      parkTicks,
      stallSide,
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
    if (markerSpot)
      placeTarget.position.set(
        markerSpot.x,
        ground(markerSpot.x, markerSpot.z) + 0.045,
        markerSpot.z,
      );
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
