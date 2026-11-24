import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createCrawler } from '../web/crawler.js';
import { armIK } from '../web/arm.js';
import { driveGround, yardClearance } from '../web/drive-ground.js';

const { instance } = await WebAssembly.instantiate(
  readFileSync(new URL('../target/wasm32-unknown-unknown/release/sandlab.wasm', import.meta.url)),
);
const core = instance.exports;
const raised = { boom: 1.12, stick: -1.21, curl: 0.3, yaw: 0 };
const flat = (_x, _z, out) => Object.assign(out, { height: 0, soil: 0, nx: 0, ny: 1, nz: 0 });
const snap = (c) => ({ x: c.position.x, y: c.position.y, z: c.position.z, ...c.state() });
const body = createCrawler(),
  results = {};
function run(n, drive = 0, steer = 0, p = raised, load = 0, surface = flat) {
  for (let i = 0; i < n; i++) body.step(p, load, drive, steer, surface);
  return snap(body);
}
body.reset(raised);
run(180);
const rest = snap(body),
  start = run(1, 1),
  cruise = run(200, 1),
  brake = run(120);
const reverse = run(105, -1);
run(120);
const preTurn = snap(body),
  turn = run(125, 0, 1);
results.flat = {
  staticDriftM: Math.hypot(rest.x, rest.z),
  staticLoadKN: rest.leftLoadKN + rest.rightLoadKN,
  firstTickSpeed: start.speed,
  cruiseSpeed: cruise.speed,
  brakeMetres: brake.x - cruise.x,
  stoppedSpeed: brake.speed,
  reverseSpeed: reverse.speed,
  pivotDegrees: ((turn.yaw - preTurn.yaw) * 180) / Math.PI,
  pivotDriftM: Math.hypot(turn.x - preTurn.x, turn.z - preTurn.z),
};

body.reset(raised, 0, 0, 2, 0);
const falling = run(12, 1, 1),
  landed = run(240);
results.air = {
  dropInPointTwoSecondsM: 2 - falling.y,
  horizontalTravelM: Math.hypot(falling.x, falling.z),
  airborneSupportKN: falling.leftLoadKN + falling.rightLoadKN,
  airborneYaw: falling.yaw,
  settledY: landed.y,
};

const extended = { boom: 0.36, stick: -0.78, curl: 0.65, yaw: Math.PI / 2 };
function lateralBalance(p, load) {
  body.reset(p, load);
  const s = run(230, 0, 0, p, load);
  return { massKg: s.massKg, com: s.comLocal, loadsKN: [s.leftLoadKN, s.rightLoadKN] };
}
results.weight = {
  empty: lateralBalance(extended, 0),
  full: lateralBalance(extended, 0.55),
  opposite: lateralBalance({ ...extended, yaw: -extended.yaw }, 0.55),
};

const jackStart = { ...armIK(5.55, 3, -0.1), yaw: 0 };
body.reset(jackStart);
run(100, 0, 0, jackStart);
let peakJack = 0,
  lightest = Infinity;
for (let i = 0; i < 230; i++) {
  const y = 3.0 - 3.3 * Math.min(1, i / 165);
  const pose = { ...armIK(5.55, y, -0.1), yaw: 0 };
  const s = run(1, 0, 0, pose);
  peakJack = Math.max(peakJack, s.bucketReactionKN);
  lightest = Math.min(lightest, s.leftLoadKN + s.rightLoadKN);
}
results.bucket = { peakBedReactionKN: peakJack, lightestTrackTotalKN: lightest };

// Crossing an abrupt break in support must create angular velocity and a fall.
const ledge = (x, z, out) => {
  flat(x, z, out);
  out.height = x > 1.2 ? -1.2 : 0;
};
body.reset(raised);
run(100, 0, 0, raised, 0, ledge);
let maxPitchRate = 0,
  minVy = 0;
for (let i = 0; i < 320; i++) {
  const s = run(1, 1, 0, raised, 0, ledge);
  maxPitchRate = Math.max(maxPitchRate, Math.abs(s.angularVelocity[2]));
  minVy = Math.min(minVy, s.verticalSpeed);
}
results.ledge = { pitchRate: maxPitchRate, descentSpeed: minVy, finalHeight: body.position.y };

function pressTracks(c, w, frame) {
  if (frame % 4 !== 0 || c.asleep) return;
  for (const pad of c.patches) {
    if (pad.soil < 0.005 || pad.normalLoad < 0.56) continue;
    core.world_press_shoe(
      w,
      pad.world.x,
      pad.world.z,
      c.angles.y,
      pad.normalLoad / (0.405 * 0.34),
      pad.slip,
      pad.side,
    );
  }
}

function parkedCrest() {
  const c = createCrawler(),
    w = core.world_new(0),
    ground = driveGround(core, w);
  const pose = { ...armIK(5.82, 2.65, -0.74), yaw: 0 };
  c.reset(pose);
  let gate = null,
    slew = 0,
    brakeX = 0,
    parkedTravel = 0,
    peakPitch = 0,
    peakRoll = 0,
    peakNoseDownDegPerSecond = 0;
  let furthestDownhill = 0,
    recoveredX = 0,
    reverseSpeed = 0;
  for (let i = 0; i < 1500; i++) {
    if (i < 36) pose.boom = Math.min(1.19, pose.boom + 0.012);
    if (gate === null && c.position.x >= 5.18) {
      gate = i;
      brakeX = c.position.x;
    }
    const age = gate === null ? -1 : i - gate;
    const target = age >= 90 && age < 176 ? 0.96 : 0;
    slew += Math.max(-1.12 / 60, Math.min(1.12 / 60, target - slew));
    pose.yaw += slew / 60;
    const climb = i >= 60 && gate === null,
      descend = age >= 235 && age < 382;
    const reverse = age >= 382 && age < 522;
    c.step(pose, 0, climb || descend ? 1 : reverse ? -1 : 0, 0, ground, yardClearance);
    pressTracks(c, w, i);
    core.world_tick(w);
    peakPitch = Math.max(peakPitch, (Math.abs(c.angles.z) * 180) / Math.PI);
    peakRoll = Math.max(peakRoll, (Math.abs(c.angles.x) * 180) / Math.PI);
    if (age >= 0 && age < 235)
      parkedTravel = Math.max(parkedTravel, Math.abs(c.position.x - brakeX));
    if (age >= 235) {
      furthestDownhill = Math.max(furthestDownhill, c.position.x);
      peakNoseDownDegPerSecond = Math.max(peakNoseDownDegPerSecond, -c.state().angularVelocity[2] * 180 / Math.PI);
    }
    if (age === 521) {
      recoveredX = c.position.x;
      reverseSpeed = c.state().speed;
    }
    if (age === 588) break;
  }
  const result = {
    gateTick: gate,
    brakeX,
    parkedTravel,
    peakPitch,
    peakRoll,
    peakNoseDownDegPerSecond,
    reverseSpeed,
    reverseClimbMetres: furthestDownhill - recoveredX,
    finalSpeed: c.state().speed,
    massError: core.world_balance(w),
  };
  core.world_drop(w);
  return result;
}
results.parkedCrest = parkedCrest();
const crest = results.parkedCrest;
assert(crest.peakNoseDownDegPerSecond < 35);
assert(crest.gateTick && crest.parkedTravel < 0.35 && crest.peakPitch < 43 && crest.peakRoll < 20);
assert(
  crest.reverseSpeed < -0.3 &&
    crest.reverseClimbMetres > 0.45 &&
    Math.abs(crest.finalSpeed) < 0.12 &&
    crest.massError === 0,
);

let grade = 0;
const sideSlope = (x, z, out) => {
  const slope = grade,
    length = Math.hypot(1, slope);
  Object.assign(out, { height: slope * z, soil: 0, nx: 0, ny: 1 / length, nz: -slope / length });
};
body.reset(extended, 0.55);
run(100, 0, 0, extended, 0.55, sideSlope);
// Quasistatic tilt table isolates load transfer from free-drop impact.
for (let i = 0; i < 240; i++) {
  grade = (0.18 * (i + 1)) / 240;
  run(1, 0, 0, extended, 0.55, sideSlope);
}
const banked = run(350, 0, 0, extended, 0.55, sideSlope);
results.crossSlope = {
  rollDeg: (banked.roll * 180) / Math.PI,
  sideLoads: [banked.leftLoadKN, banked.rightLoadKN],
  speed: banked.speed,
};
assert(Math.abs((banked.roll * 180) / Math.PI + (Math.atan(0.18) * 180) / Math.PI) < 1);
assert(banked.leftLoadKN > banked.rightLoadKN + 40 && Math.abs(banked.speed) < 0.02);
function quarryRun() {
  const c = createCrawler(),
    w = core.world_new(0);
  const sample = driveGround(core, w),
    points = [],
    times = [];
  c.reset(raised);
  let maxY = 0,
    minPitch = 10,
    maxPitch = -10,
    maxSlip = 0,
    atCrest = null,
    maxRate = 0;
  for (let i = 0; i < 1100; i++) {
    const t = performance.now();
    c.step(raised, 0, i >= 70 && i < 950 ? 1 : 0, 0, sample, yardClearance);
    pressTracks(c, w, i);
    const duration = performance.now() - t;
    if (i > 70 && i < 950) times.push(duration);
    core.world_tick(w);
    const s = c.state();
    maxY = Math.max(maxY, c.position.y);
    maxPitch = Math.max(maxPitch, s.pitch);
    minPitch = Math.min(minPitch, s.pitch);
    maxSlip = Math.max(maxSlip, s.slip);
    maxRate = Math.max(maxRate, Math.abs(s.angularVelocity[2]));
    if (!atCrest && c.position.x > 5.45)
      atCrest = { tick: i, x: c.position.x, height: c.position.y, speed: s.speed };
    if (i % 60 === 0)
      points.push([
        i,
        c.position.x,
        c.position.y,
        (s.pitch * 180) / Math.PI,
        s.speed,
        s.supportCount,
      ]);
  }
  const final = snap(c),
    balance = core.world_balance(w),
    hash = core.world_hash(w) >>> 0;
  core.world_drop(w);
  times.sort((a, b) => a - b);
  return {
    peakHeight: maxY,
    upPitch: (maxPitch * 180) / Math.PI,
    downPitch: (minPitch * 180) / Math.PI,
    maxRate,
    maxSlip,
    atCrest,
    endX: final.x,
    endY: final.y,
    massError: balance,
    hash,
    p95ChassisAndPressureMs: times[Math.floor(times.length * 0.95)],
    points,
  };
}
results.quarry = quarryRun();
console.log(JSON.stringify(results, null, 2));
const { flat: f, air, weight, bucket, ledge: edge, quarry: q } = results;
assert(f.staticDriftM < 0.03 && Math.abs(f.staticLoadKN - 20.4 * 9.81) < 3);
assert(f.firstTickSpeed < 0.1 && f.cruiseSpeed > 1.4 && f.reverseSpeed < -1.4);
assert(f.brakeMetres > 0.15 && f.brakeMetres < 0.75 && Math.abs(f.stoppedSpeed) < 0.02);
assert(Math.abs(f.pivotDegrees) > 35 && f.pivotDriftM < 1.09);
assert(air.dropInPointTwoSecondsM > 0.18 && air.dropInPointTwoSecondsM < 0.23);
assert(
  air.horizontalTravelM < 0.001 &&
    Math.abs(air.airborneYaw) < 0.001 &&
    air.airborneSupportKN === 0 &&
    Math.abs(air.settledY) < 0.03,
);
assert(Math.abs(weight.full.massKg - weight.empty.massKg - 880) < 0.001);
assert(
  weight.full.loadsKN[0] > weight.empty.loadsKN[0] + 12 &&
    weight.opposite.loadsKN[1] > weight.opposite.loadsKN[0] + 30,
);
assert(bucket.peakBedReactionKN > 20 && bucket.lightestTrackTotalKN < 185);
assert(edge.pitchRate > 0.3 && edge.descentSpeed < -0.3 && edge.finalHeight < -1.0);
assert(q.atCrest && q.endX > 8 && q.upPitch > 15 && q.downPitch < -12 && q.massError === 0);
const again = quarryRun();
assert.equal(again.hash, q.hash);
assert.deepEqual(again.points, q.points);
if (process.argv.includes('--write'))
  writeFileSync(
    new URL('../evidence/drive.json', import.meta.url),
    JSON.stringify(results, null, 2) + '\n',
  );
