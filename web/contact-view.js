import * as T from 'three';

export function createContactView(scene, body) {
  const geometry = new T.BufferGeometry();
  const positions = new T.BufferAttribute(new Float32Array((body.patches.length + 2) * 6), 3);
  const colours = new T.BufferAttribute(new Float32Array(positions.count * 3), 3);
  positions.setUsage(T.DynamicDrawUsage);
  geometry.setAttribute('position', positions);
  geometry.setAttribute('color', colours);
  const lines = new T.LineSegments(
    geometry,
    new T.LineBasicMaterial({ vertexColors: true, depthTest: false, toneMapped: false }),
  );
  const weight = new T.Mesh(
    new T.SphereGeometry(0.095, 12, 8),
    new T.MeshBasicMaterial({ color: 0xffaa38, depthTest: false, toneMapped: false }),
  );
  lines.frustumCulled = false;
  lines.renderOrder = 8;
  weight.renderOrder = 9;
  lines.visible = weight.visible = false;
  scene.add(lines, weight);
  const tip = new T.Vector3(),
    colour = new T.Color();
  let active = false;
  return {
    toggle() {
      active = !active;
      lines.visible = weight.visible = active;
      return active;
    },
    update(ground) {
      if (!active) return;
      let n = 0;
      function segment(from, to, tint) {
        for (const v of [from, to]) {
          positions.setXYZ(n, v.x, v.y, v.z);
          colours.setXYZ(n, tint.r, tint.g, tint.b);
          n++;
        }
      }
      weight.position.copy(body.comWorld);
      tip.copy(body.comWorld);
      tip.y = ground(tip.x, tip.z);
      segment(body.comWorld, tip, colour.setHex(0xffaa38));
      for (const p of body.patches) {
        if (p.normalLoad < 0.65) continue;
        tip.copy(p.world).addScaledVector(p.n.axis, Math.min(1.15, p.normalLoad * 0.03));
        segment(p.world, tip, colour.setHex(p.side < 0 ? 0x60f0ce : 0x99d5ff));
      }
      geometry.setDrawRange(0, n);
      positions.needsUpdate = colours.needsUpdate = true;
    },
  };
}
