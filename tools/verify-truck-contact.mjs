import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCrawler } from '../web/crawler.js';
import { armIK } from '../web/arm.js';
import { fleet, addTruckBeds } from '../web/trucks.js';
import { driveGround, haulClearance } from '../web/drive-ground.js';
import {
  clearTruckReactions,
  checkDispatchLane,
  positionTruckWalls,
  truckHulls,
  truckInputs,
} from '../web/truck-contact.js';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const wasm = Buffer.from(html.match(/<script id="wasm"[^>]*>([^<]+)/)[1], 'base64');
const { instance } = await WebAssembly.instantiate(wasm);
const core = instance.exports;
const results = {};
for (const [name, x, z, yaw, direction, house] of [
  ['red bed side', -0.35, -0.6, Math.PI / 2, 1, Math.PI],
  ['rear counterweight', -0.35, -0.6, -Math.PI / 2, -1, 0],
  ['red cab diagonal', 4.3, -10.5, -Math.PI * 0.61, 1, Math.PI],
  ['Mule tail', -0.1, 1.35, Math.PI, 1, Math.PI],
]) {
  const w = core.haul_new(0);
  addTruckBeds(core, w);
  const chassis = createCrawler(),
    sample = driveGround(core, w);
  const p = { ...armIK(4.25, 4.45, 0.5), yaw: house };
  chassis.reset(p, 0, x, 0, z, yaw);
  let worst = 0,
    maxHeight = 0,
    maxContact = 0,
    atWall;
  for (let f = 0; f < 720; f++) {
    positionTruckWalls(core, w);
    clearTruckReactions();
    chassis.step(p, 0, f < 60 ? 0 : f < 480 ? direction : -direction, 0, sample, haulClearance);
    for (let i = 0; i < fleet.length; i++) {
      const input = truckInputs(i);
      core.world_truck_contact(w, i, ...input);
      maxContact = Math.max(maxContact, input[0], input[3]);
    }
    core.world_tick(w);
    const d = truckHulls(p, chassis.position, chassis.rotation, null, 0.035);
    if (f < 480) {
      worst = Math.min(worst, d);
      maxHeight = Math.max(maxHeight, chassis.position.y);
    }
    if (f === 479) atWall = chassis.position.clone();
  }
  const reverse = chassis.position.distanceTo(atWall);
  results[name] = {
    penetrationM: -worst,
    peakChassisY: maxHeight,
    reverseM: reverse,
    contact: maxContact,
    wall: atWall.toArray(),
  };
  core.world_drop(w);
}

for (const [name, r] of Object.entries(results)) {
  assert.ok(r.penetrationM < 0.005, name + ' interpenetration');
  assert.ok(r.peakChassisY < 0.45, name + ' climbed the truck');
  assert.ok(r.reverseM > 1.8, name + ' failed to back away');
}

// A loaded tipper should wait for the crawler in its departure lane, then
// leave when the player withdraws. A zero-quantity order starts its driver.
const yard = core.haul_new(0);
for (const [i, t] of fleet.entries())
  core.world_add_truck(
    yard,
    t.x,
    t.z,
    t.length / 2,
    t.width / 2,
    t.floor,
    i === 0 ? 0 : 80000,
    t.heading,
    i,
  );
const parked = createCrawler();
const pose = { ...armIK(3.8, 4.2, 0.5), yaw: Math.PI };
parked.reset(pose, 0, 7.4, 0, -5.5, Math.PI / 2);
const read = driveGround(core, yard);
let closest = Infinity,
  stopped;
for (let tick = 0; tick < 1320; tick++) {
  if (tick === 720) parked.reset(pose, 0, 8, 0, 0, 0);
  positionTruckWalls(core, yard);
  clearTruckReactions();
  parked.step(pose, 0, 0, 0, read, haulClearance);
  checkDispatchLane(pose, parked.position, parked.rotation, 0);
  core.world_truck_contact(yard, 0, ...truckInputs(0));
  core.world_tick(yard);
  if (tick < 720)
    closest = Math.min(closest, truckHulls(pose, parked.position, parked.rotation, null, 0.5));
  if (tick === 719) stopped = core.world_truck_offset(yard, 0);
}
const departed = core.world_truck_offset(yard, 0);
assert.ok(
  stopped > 0.2 && stopped < 4.2 && closest > -0.01,
  'truck must stop before the parked crawler',
);
assert.ok(departed > 5.79, 'truck must resume after lane clears');
assert.equal(core.world_ground(yard, 1.94, 5.1), 0, 'obsolete weigh wall in haul');
const quarry = core.world_new(0);
assert.ok(core.world_ground(quarry, 1.94, 5.1) > 0.75, 'original weigh wall missing in quarry');
const crossing = createCrawler();
crossing.reset(pose, 0, 0, 0, 5.1, 0);
let farX;
for (let tick = 0; tick < 660; tick++) {
  positionTruckWalls(core, yard);
  crossing.step(pose, 0, tick < 300 ? 1 : -1, 0, read, haulClearance);
  core.world_tick(yard);
  if (tick === 299) farX = crossing.position.x;
}
assert.ok(farX > 5 && crossing.position.x < 1, 'failed to cross former weigh bay in both directions');
results.formerWeighBay = { farX, returnedX: crossing.position.x };
core.world_drop(quarry);
core.world_drop(yard);
results.dispatch = { stoppedM: stopped, closestM: closest, completedM: departed };
console.log(JSON.stringify(results, null, 2));
