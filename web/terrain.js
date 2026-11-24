import * as THREE from 'three';

const N = 256,
  TILES = 16,
  SIDE = 16,
  SCALE = 0.125;

export function createGround(scene) {
  const geometry = new THREE.PlaneGeometry((N - 1) * SCALE, (N - 1) * SCALE, N - 1, N - 1);
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.attributes.position,
    normal = geometry.attributes.normal;
  pos.setUsage(THREE.DynamicDrawUsage);
  normal.setUsage(THREE.DynamicDrawUsage);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 24);
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96 });
  const mask = new Uint8Array(TILES * TILES);
  const activeMap = new THREE.DataTexture(mask, TILES, TILES, THREE.RedFormat);
  activeMap.needsUpdate = true;
  const inspect = { value: 0 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.activeMap = { value: activeMap };
    shader.uniforms.inspect = inspect;
    shader.vertexShader =
      'varying vec3 quarryPoint;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nquarryPoint = position;',
      );
    shader.fragmentShader =
      `varying vec3 quarryPoint; uniform sampler2D activeMap; uniform float inspect;
      float sandHash(vec2 p){ vec3 a=fract(vec3(p.xyx)*.1031); a+=dot(a,a.yzx+33.33); return fract((a.x+a.y)*a.z); }
      float sandNoise(vec2 p){vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(sandHash(i),sandHash(i+vec2(1.,0.)),f.x),mix(sandHash(i+vec2(0.,1.)),sandHash(i+1.),f.x),f.y);}
    ` +
      shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
      vec2 ground=quarryPoint.xz; float high=quarryPoint.y;
      float strata=sandNoise(ground*.32)*.7+sandNoise(ground*1.8)*.3;
      float dirt=smoothstep(.012,.23,high+.06*(strata-.5));
      vec3 gravel=mix(vec3(.32,.245,.167),vec3(.45,.36,.26),strata);
      vec3 sand=mix(vec3(.62,.37,.15),vec3(.77,.525,.255),strata);
      float pixel=max(fwidth(ground.x),fwidth(ground.y));
      float grit=(sandNoise(ground*72.)-.5)*(1.-smoothstep(.007,.035,pixel));
      float ripples=sin(ground.x*18.+ground.y*5.+strata*9.)*dirt*.016*(1.-smoothstep(.025,.1,pixel));
      diffuseColor.rgb=mix(gravel,sand,dirt)*(1.+.13*grit+ripples);
      if(inspect>.5){vec2 tiles=(ground+16.)*.5;vec2 edge=min(fract(tiles),1.-fract(tiles));
        float busy=texture2D(activeMap,(floor(tiles)+.5)/16.).r;
        diffuseColor.rgb=mix(diffuseColor.rgb,mix(vec3(.045,.18,.18),vec3(.97,.34,.028),busy),.55);
        if(min(edge.x,edge.y)<.013)diffuseColor.rgb*=.45;} `,
      );
  };
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = mesh.castShadow = true;
  scene.add(mesh);
  const lo = new Int16Array(N),
    hi = new Int16Array(N);
  function sync(core, world) {
    const memory = core.memory.buffer;
    const flags = new Uint8Array(memory, core.world_dirty(world), TILES * TILES);
    const heights = new Int32Array(memory, core.world_height(world), N * N);
    const compact = new Uint8Array(memory, core.world_compact(world), N * N);
    if (inspect.value) {
      const active = new Uint8Array(memory, core.world_active(world), TILES * TILES);
      let changed = false;
      for (let i = 0; i < mask.length; i++) {
        const level = active[i] ? 255 : 0;
        if (mask[i] !== level) {
          mask[i] = level;
          changed = true;
        }
      }
      if (changed) activeMap.needsUpdate = true;
    }
    const depth = (i) => heights[i] - ((heights[i] * compact[i]) >> 11);
    lo.fill(N);
    hi.fill(-1);
    for (let tile = 0; tile < flags.length; tile++) {
      if (!flags[tile]) continue;
      const x = (tile % TILES) * SIDE,
        z = (tile >> 4) * SIDE;
      for (let row = Math.max(0, z - 1); row < Math.min(N, z + SIDE + 1); row++) {
        lo[row] = Math.min(lo[row], Math.max(0, x - 1));
        hi[row] = Math.max(hi[row], Math.min(N - 1, x + SIDE));
      }
    }
    let bytes = 0;
    for (let z = 0; z < N; z++) {
      if (hi[z] < lo[z]) continue;
      for (let x = lo[z]; x <= hi[z]; x++) {
        const i = z * N + x;
        const nx =
          (depth(z * N + Math.max(0, x - 1)) - depth(z * N + Math.min(N - 1, x + 1))) * 0.004;
        const nz =
          (depth(Math.max(0, z - 1) * N + x) - depth(Math.min(N - 1, z + 1) * N + x)) * 0.004;
        const inv = 1 / Math.hypot(nx, 1, nz);
        pos.setY(i, depth(i) * 0.001);
        normal.setXYZ(i, nx * inv, inv, nz * inv);
      }
      const start = (z * N + lo[z]) * 3,
        count = (hi[z] - lo[z] + 1) * 3;
      pos.addUpdateRange(start, count);
      normal.addUpdateRange(start, count);
      bytes += count * 8;
    }
    if (bytes) {
      pos.needsUpdate = normal.needsUpdate = true;
      core.world_clear_dirty(world);
    }
    return bytes;
  }
  return {
    sync,
    inspect: (on) => {
      inspect.value = Number(on);
    },
  };
}

export function createStream(scene) {
  const geometry = new THREE.IcosahedronGeometry(1, 0);
  const grains = new THREE.InstancedMesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0xd2a060, roughness: 0.92, flatShading: true }),
    640 * 3,
  );
  grains.frustumCulled = false;
  grains.count = 0;
  grains.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(grains);
  const m = new THREE.Object3D();
  return function sync(core, world) {
    const n = core.world_air_len(world);
    grains.count = n * 3;
    if (!n) return;
    const addr = core.world_air(world),
      buf = core.memory.buffer;
    const data = new Float32Array(buf, addr, n * 7),
      mass = new Int32Array(buf, addr, n * 7);
    for (let i = 0; i < n; i++) {
      const j = 7 * i,
        r = Math.cbrt(mass[j + 3] / 64000) * 0.34;
      for (let k = 0; k < 3; k++) {
        m.position.set(
          data[j] + (k - 1) * r * 0.85,
          data[j + 1] + (k % 2) * r * 0.35,
          data[j + 2] + (1 - k) * r * 0.55,
        );
        m.scale.set(r * 0.79, r * 0.67, r * 0.76);
        m.rotation.y = (i * 13 + k) * 0.73;
        m.updateMatrix();
        grains.setMatrixAt(3 * i + k, m.matrix);
      }
    }
    grains.instanceMatrix.clearUpdateRanges();
    grains.instanceMatrix.addUpdateRange(0, n * 3 * 16);
    grains.instanceMatrix.needsUpdate = true;
  };
}
