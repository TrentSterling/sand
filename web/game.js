import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createMachine } from './machine.js';
import { createQuarry } from './quarry.js';
import { createGround, createStream } from './terrain.js';
import { createTreads } from './treads.js';

const byId = (id) => document.getElementById(id);
const clamp = THREE.MathUtils.clamp,
  mix = THREE.MathUtils.lerp;
const capacity = 67200,
  units = 64000,
  step = 1 / 60;
const note = (text) => {
  byId('feedback').textContent = text;
};
const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const fmt = (v) => (v / units).toFixed(2) + ' m³';

function armIK(r, h, pitch) {
  const a = 4.45,
    b = 2.65;
  const x = r - 0.55 - (0.86 * Math.cos(pitch) + 0.52 * Math.sin(pitch));
  const y = h - 1.55 - (0.86 * Math.sin(pitch) - 0.52 * Math.cos(pitch));
  const stick = clamp(
    -Math.acos(clamp((x * x + y * y - a * a - b * b) / (2 * a * b), -1, 1)),
    -2.55,
    -0.35,
  );
  const boom = clamp(
    Math.atan2(y, x) - Math.atan2(b * Math.sin(stick), a + b * Math.cos(stick)),
    -0.18,
    1.19,
  );
  return { boom, stick, curl: clamp(pitch - boom - stick, -1.15, 2.35) };
}
function forward(p) {
  const middle = p.boom + p.stick,
    pitch = middle + p.curl;
  return {
    r:
      0.55 +
      4.45 * Math.cos(p.boom) +
      2.65 * Math.cos(middle) +
      0.86 * Math.cos(pitch) +
      0.52 * Math.sin(pitch),
    h:
      1.55 +
      4.45 * Math.sin(p.boom) +
      2.65 * Math.sin(middle) +
      0.86 * Math.sin(pitch) -
      0.52 * Math.cos(pitch),
    pitch,
    yaw: p.yaw,
  };
}

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
  const replay = new Float32Array(9 * 3600);
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
      camera.position.sub(controls.target).multiplyScalar(factor / framing).add(controls.target);
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
    w = core.world_new(0);
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
    const x = target.x - base.x,
      z = target.z - base.z;
    return { r: Math.hypot(x, z), yaw: -Math.atan2(z, x) - trackYaw };
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
        const high = core.world_ground(w, source.x, source.z);
        const cut = Math.max(0.035, high * 0.26);
        goals = [
          make(start.r, Math.max(start.h, 2.55), -0.22, start.yaw, 32),
          make(bank.r + 1.05, Math.max(2.8, high + 0.5), -0.82, bank.yaw, 78),
          make(bank.r + 0.56, cut, -0.85, bank.yaw, 55),
          make(Math.max(2.3, bank.r - 1.42), cut + 0.045, 0.46, bank.yaw, 73),
        ];
        note('Teeth down. Watch the cut as the stick draws in.');
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
    const s = sequence[0];
    if (!s.begin) {
      s.begin = forward(p);
      s.elapsed = 0;
    }
    s.elapsed += action === 'dig' ? availableTorque : 1;
    const t = Math.min(1, s.elapsed / s.ticks),
      f = t * t * (3 - 2 * t),
      a = s.begin;
    Object.assign(p, armIK(mix(a.r, s.r, f), mix(a.h, s.h, f), mix(a.pitch, s.pitch, f)));
    p.yaw = a.yaw + angleDelta(a.yaw, s.yaw) * f;
    if (t === 1) {
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
    p.boom = clamp(p.boom + axis('boomUp', 'boomDown') * 0.012, -0.18, 1.19);
    p.stick = clamp(p.stick + axis('stickOut', 'stickIn') * 0.017 * availableTorque, -2.55, -0.35);
    p.curl = clamp(p.curl + axis('curlIn', 'curlOut') * 0.026 * availableTorque, -1.15, 2.35);
    p.yaw += axis('left', 'right') * 0.018;
    const turn = axis('steerLeft', 'steerRight') * 0.012;
    trackYaw += turn;
    const advance = axis('driveForward', 'driveBack') * 0.031;
    const x = clamp(base.x + advance * Math.cos(trackYaw), -12.5, 12.5),
      z = clamp(base.z - advance * Math.sin(trackYaw), -12.5, 12.5);
    if (!(Math.abs(x) < 3.2 && z > 2.63 && z < 8.8)) {
      trackMoved = x !== base.x || z !== base.z;
      base.x = x;
      base.z = z;
      travel += advance;
    }
    trackMoved ||= turn !== 0;
  }
  function updateMachine() {
    const c = Math.cos(trackYaw),
      s = Math.sin(trackYaw);
    const sample = (f, l) => core.world_ground(w, base.x + c * f + s * l, base.z - s * f + c * l);
    const fl = sample(1.55, -1.06),
      fr = sample(1.55, 1.06),
      bl = sample(-1.55, -1.06),
      br = sample(-1.55, 1.06);
    const gx = (fl + fr + bl + br) * 0.25;
    base.y = Math.abs(base.y - gx) < 0.001 ? gx : mix(base.y, gx, 0.15);
    const rise = clamp(Math.atan2(fl + fr - bl - br, 6.2), -0.38, 0.38);
    const roll = clamp(Math.atan2(fl + bl - fr - br, 4.24), -0.32, 0.32);
    const load = core.world_load(w) / capacity;
    const key = [
      p.boom,
      p.stick,
      p.curl,
      p.yaw,
      load,
      travel,
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
    }
    rig.root.position.set(base.x, base.y, base.z);
    rig.root.rotation.set(roll, trackYaw, rise, 'YXZ');
    rig.pose({ ...p, load, travel, turn: trackYaw });
    renderer.shadowMap.needsUpdate = true;
    rig.tip.getWorldPosition(tip);
  }
  function tick() {
    const prev = forward(p);
    trackMoved = false;
    if (sequence.length) animateArm();
    if (manual) moveManual();
    updateMachine();
    const e = rig.bucket.matrixWorld.elements;
    const pitch = Math.atan2(e[1], Math.hypot(e[0], e[2])),
      yaw = -Math.atan2(e[2], e[0]);
    const now = performance.now();
    if (trackMoved) core.world_tracks(w, base.x, base.z, trackYaw);
    core.world_tool(w, tip.x, tip.y, tip.z, yaw, pitch);
    core.world_tick(w);
    simMs += performance.now() - now;
    renderTicks++;
    const penetration = Math.max(0, core.world_ground(w, tip.x, tip.z) - tip.y);
    availableTorque =
      1 / (1 + 0.48 * Math.min(1.2, penetration) + (0.17 * core.world_load(w)) / capacity);
    visits = core.world_visited(w) * 2;
    clock += step;
    maxLoad = Math.max(maxLoad, core.world_load(w));
    if (frame < 3600) {
      const j = frame * 9;
      replay[j] = tip.x;
      replay[j + 1] = tip.y;
      replay[j + 2] = tip.z;
      replay[j + 3] = yaw;
      replay[j + 4] = pitch;
      replay[j + 5] = Number(trackMoved);
      replay[j + 6] = base.x;
      replay[j + 7] = base.z;
      replay[j + 8] = trackYaw;
      if (action || manual) savedMotion++;
    }
    frame++;
    if (trackMoved || frame === 1)
      treads.update(base.x, base.z, trackYaw, (x, z) => core.world_ground(w, x, z));
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
    byId('simTime').textContent = (simMs / Math.max(1, renderTicks)).toFixed(3) + ' ms';
    byId('visited').textContent = visits.toLocaleString() + ' / 65,536';
    if (!byId('lab').hidden) {
      byId('massError').textContent = core.world_balance(w) + ' units';
      byId('upload').textContent = (uploadBytes / 1024).toFixed(1) + ' KiB';
      byId('meshTime').textContent = terrainMs.toFixed(2) + ' ms';
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
      const actual = scenario === 'player' && savedMotion > 30 && maxLoad > 100;
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
              const j = f * 9;
              if (replay[j + 5])
                core.world_tracks(handle, replay[j + 6], replay[j + 7], replay[j + 8]);
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
      const result = {
        source: actual ? 'Your dig' : avalanche ? 'Quarry-wide avalanche' : 'Reference dig',
        ticks: frames,
        sparseMs: times[0],
        denseMs: times[1],
        pairs,
        match: equal,
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
  byId('tiles').onclick = () => {
    const on = byId('tiles').getAttribute('aria-pressed') !== 'true';
    byId('tiles').setAttribute('aria-pressed', String(on));
    terrain.inspect(on);
  };
  byId('manual').onclick = () => setManual(!manual);
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
    keyHeld.clear();
    pointerHeld.clear();
    accum = 0;
    lastNow = 0;
  };
  window.addEventListener('blur', inputsOff);
  document.addEventListener('visibilitychange', inputsOff);
  byId('view').addEventListener('dblclick', (ev) => {
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
      if (aim.r > 7.65 || aim.r < 2) {
        note('Outside arm reach. Drive closer to the cut.');
        break;
      }
      sequence = [{ ...aim, h: hit.y - base.y, pitch: -0.6, ticks: 65 }];
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
      base: { ...base },
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
    controls.update();
    renderer.render(scene, camera);
    frameSum += wallTime;
    frameCount++;
    sinceHud += dt;
    if (sinceHud >= 0.25) {
      fps = frameCount / frameSum;
      hud();
      sinceHud = 0;
      simMs = 0;
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
