// Rest the two rigid shoe runs on the upper terrain envelope. A truck-style
// average of four corner heights can bury the middle of a crawler in a crest.
const halfGauge = 1.09,
  halfLength = 1.62,
  samples = 9;
const positions = Array.from(
  { length: samples },
  (_, i) => halfLength * ((2 * i) / (samples - 1) - 1),
);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export function createSupport() {
  let previous = null;
  const heights = new Float64Array(samples * 2);
  function evaluate(a) {
    let left = -Infinity,
      right = -Infinity;
    for (let i = 0; i < samples; i++) {
      left = Math.max(left, heights[i] - a * positions[i]);
      right = Math.max(right, heights[i + samples] - a * positions[i]);
    }
    const b = clamp((right - left) / (2 * halfGauge), -0.5, 0.5);
    return { a, b, y: Math.max(left + b * halfGauge, right - b * halfGauge) };
  }
  function restingPlane() {
    let lo = -0.57,
      hi = 0.57;
    for (let i = 0; i < 18; i++) {
      const d = (hi - lo) / 3;
      if (evaluate(lo + d).y <= evaluate(hi - d).y) hi -= d;
      else lo += d;
    }
    const best = evaluate((lo + hi) / 2),
      level = evaluate(0);
    return level.y <= best.y + 0.0001 ? level : best;
  }
  return (x, z, yaw, ground) => {
    let rise = previous?.rise ?? 0,
      roll = previous?.roll ?? 0,
      y = 0;
    const c = Math.cos(yaw),
      s = Math.sin(yaw);
    for (let pass = 0; pass < 3; pass++) {
      let changed = !previous || x !== previous.x || z !== previous.z || yaw !== previous.yaw;
      for (let k = 0; k < samples * 2; k++) {
        const f = positions[k % samples],
          l = k < samples ? -halfGauge : halfGauge;
        const fx = Math.cos(rise) * f,
          lz = Math.sin(roll) * Math.sin(rise) * f + Math.cos(roll) * l;
        const h = ground(x + c * fx + s * lz, z - s * fx + c * lz);
        if (Math.abs(heights[k] - h) > 0.0001) changed = true;
        heights[k] = h;
      }
      if (!changed && pass === 0) return previous;
      const plane = restingPlane();
      y = plane.y;
      const rr = -Math.asin(plane.b),
        pr = Math.asin(clamp(plane.a / Math.cos(rr), -0.65, 0.65));
      if (Math.abs(pr - rise) + Math.abs(rr - roll) < 0.0002) {
        rise = pr;
        roll = rr;
        break;
      }
      rise = pr;
      roll = rr;
    }
    previous = { x, z, yaw, y, rise, roll };
    return previous;
  };
}
