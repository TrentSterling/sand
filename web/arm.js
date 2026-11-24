import { machineDimensions as rig } from './machine.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const [sx, sy] = rig.shoulder,
  [tx, ty] = rig.tooth;
const B = rig.boom,
  S = rig.stick,
  mount = rig.mountAngle;
const [b0, b1] = rig.limits.boom,
  [s0, s1] = rig.limits.stick,
  [q0, q1] = rig.limits.curl;

// Positive pitch raises the inward-facing lip. Physical rotation about +Z has the opposite sign.
export function forward({ boom, stick, curl, yaw = 0 }) {
  const middle = boom + stick,
    pitch = curl - mount - middle;
  const wristX = sx + B * Math.cos(boom) + S * Math.cos(middle);
  const wristY = sy + B * Math.sin(boom) + S * Math.sin(middle);
  return {
    r: wristX + tx * Math.cos(pitch) + ty * Math.sin(pitch),
    h: wristY - tx * Math.sin(pitch) + ty * Math.cos(pitch),
    pitch,
    yaw,
    wristX,
    wristY,
  };
}

export function armIK(r, h, requestedPitch) {
  const pitch = clamp(requestedPitch, q0 - mount - b1 - s1, q1 - mount - b0 - s0);
  const x = r - sx - tx * Math.cos(pitch) - ty * Math.sin(pitch);
  const y = h - sy + tx * Math.sin(pitch) - ty * Math.cos(pitch);
  const sumLo = q0 - pitch - mount,
    sumHi = q1 - pitch - mount;
  const stick = -Math.acos(clamp((x * x + y * y - B * B - S * S) / (2 * B * S), -1, 1));
  const boom = Math.atan2(y, x) - Math.atan2(S * Math.sin(stick), B + S * Math.cos(stick));
  const result = (b, s) => ({ boom: b, stick: s, curl: clamp(pitch + mount + b + s, q0, q1) });
  if (
    boom >= b0 &&
    boom <= b1 &&
    stick >= s0 &&
    stick <= s1 &&
    boom + stick >= sumLo &&
    boom + stick <= sumHi
  ) {
    return result(boom, stick);
  }
  // At fixed pitch the workspace boundary consists of six circular arcs: shoulder,
  // elbow and curl stops in both directions. Project onto each feasible arc.
  let best = null,
    error = Infinity;
  function candidate(b, s) {
    const dx = B * Math.cos(b) + S * Math.cos(b + s) - x,
      dy = B * Math.sin(b) + S * Math.sin(b + s) - y;
    const score = dx * dx + dy * dy;
    if (score < error) {
      error = score;
      best = result(b, s);
    }
  }
  function arc(lo, hi, angle, test) {
    if (lo > hi + 1e-12) return;
    const mid = (lo + hi) / 2;
    angle += 2 * Math.PI * Math.round((mid - angle) / (2 * Math.PI));
    test(clamp(angle, lo, hi));
  }
  for (const b of [b0, b1])
    arc(
      Math.max(s0, sumLo - b),
      Math.min(s1, sumHi - b),
      Math.atan2(y - B * Math.sin(b), x - B * Math.cos(b)) - b,
      (s) => candidate(b, s),
    );
  for (const s of [s0, s1])
    arc(
      Math.max(b0, sumLo - s),
      Math.min(b1, sumHi - s),
      Math.atan2(y, x) - Math.atan2(S * Math.sin(s), B + S * Math.cos(s)),
      (b) => candidate(b, s),
    );
  for (const sum of [sumLo, sumHi])
    arc(
      Math.max(b0, sum - s1),
      Math.min(b1, sum - s0),
      Math.atan2(y - S * Math.sin(sum), x - S * Math.cos(sum)),
      (b) => candidate(b, sum - b),
    );
  return best;
}

// Report true pitch past vertical. The transverse pin determines the houseward axis
// even when the bucket's longitudinal axis points straight up or down.
export function toolAttitude(elements) {
  const lateralX = elements[8],
    lateralY = elements[9],
    lateralZ = elements[10];
  const length = Math.hypot(lateralX, lateralZ);
  const fx = lateralZ / length,
    fz = -lateralX / length;
  const horizontal = elements[0] * fx + elements[2] * fz;
  const vertical =
    (elements[1] -
      lateralY * (elements[0] * lateralX + elements[1] * lateralY + elements[2] * lateralZ)) /
    length;
  return { pitch: -Math.atan2(vertical, horizontal), yaw: -Math.atan2(fz, fx) };
}
