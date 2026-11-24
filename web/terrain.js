import * as THREE from 'three';

const N = 256,
  TILES = 16,
  SIDE = 16,
  SCALE = 0.125;

export function createGround(scene) {
  const geometry = new THREE.PlaneGeometry((N - 1) * SCALE, (N - 1) * SCALE, N - 1, N - 1);
  geometry.rotateX(-Math.PI / 2);
  // Keep the seeded bank as a surface reference. Exposed strata and newly
  // deposited loose material follow the actual cut in any direction.
  const bankDatum = new THREE.BufferAttribute(new Float32Array(N * N), 1);
  geometry.setAttribute('bankDatum', bankDatum);
  const packed = new THREE.BufferAttribute(new Uint8Array(N * N), 1, true);
  packed.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('packedSoil', packed);
  const trackFrame = {value: new THREE.Matrix4()};
  let seededDatum = false;
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
    shader.uniforms.trackFrame = trackFrame;
    shader.vertexShader =
      'attribute float bankDatum; attribute float packedSoil; varying float density; varying float bankChange; varying vec3 quarryPoint;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\ndensity=packedSoil; quarryPoint = position; bankChange=position.y-bankDatum;',
      );
    shader.fragmentShader =
      `varying vec3 quarryPoint; varying float bankChange; varying float density; uniform mat4 trackFrame; uniform sampler2D activeMap; uniform float inspect;
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
      float exposed=smoothstep(.035,.32,-bankChange);
      float bedding=high*27.+ground.x*1.1+ground.y*.55+3.*strata;
      float seam=smoothstep(.56,.94,sin(bedding))*exposed;
      sand=mix(sand,sand*vec3(.72,.61,.49),exposed*.54+seam*.33);
      sand=mix(sand,vec3(.77,.505,.23),.33*smoothstep(.04,.28,bankChange));
      float pixel=max(fwidth(ground.x),fwidth(ground.y));
      float grit=(sandNoise(ground*72.)-.5)*(1.-smoothstep(.007,.035,pixel));
      float ripples=sin(ground.x*18.+ground.y*5.+strata*9.)*dirt*.016*(1.-smoothstep(.025,.1,pixel));
      diffuseColor.rgb=mix(gravel,sand,dirt)*(1.+.13*grit+ripples);
      // Packed sand breaks the light differently on the actual pressure paths.
      float burnish=smoothstep(.035,.68,density);
      diffuseColor.rgb *= mix(vec3(1.),vec3(.65,.60,.53),burnish*dirt);
      // Near-field contact shade follows the two curved track soles. An
      // overhanging shoe progressively loses this short-range occlusion.
      vec3 under=(trackFrame*vec4(quarryPoint,1.)).xyz;
      float end=max(abs(under.x)-1.62,0.);
      float across=max(abs(abs(under.z)-1.09)-.34,0.);
      float sole=.45-sqrt(max(0.,.45*.45-end*end));
      float gap=max(0.,sole-under.y);
      float occ=(1.-smoothstep(.02,.42,across))*(1.-smoothstep(.035,.46,gap))
               *(1.-smoothstep(.38,.68,end));
      diffuseColor.rgb *= 1.-.55*occ;
      if(inspect>.5 && max(abs(ground.x),abs(ground.y))<16.){vec2 tiles=(ground+16.)*.5;vec2 edge=min(fract(tiles),1.-fract(tiles));
        float busy=texture2D(activeMap,(floor(tiles)+.5)/16.).r;
        diffuseColor.rgb=mix(diffuseColor.rgb,mix(vec3(.045,.18,.18),vec3(.97,.34,.028),busy),.55);
        if(min(edge.x,edge.y)<.013)diffuseColor.rgb*=.45;} `,
      );
  };
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = mesh.castShadow = true;
  scene.add(mesh);
  // Same world-space material on both sides of the CPU grid boundary.
  const outer = 76,
    edge = (N - 1) * SCALE * 0.5,
    ringPositions = [];
  for (const size of [edge, outer]) {
    for (const [x, z] of [
      [-1, -1],
      [-1, 1],
      [1, 1],
      [1, -1],
    ])
      ringPositions.push(x * size, 0, z * size);
  }
  const apronGeom = new THREE.BufferGeometry(),
    indices = [];
  apronGeom.setAttribute('packedSoil',new THREE.BufferAttribute(new Uint8Array(8),1,true));
  apronGeom.setAttribute('bankDatum', new THREE.BufferAttribute(new Float32Array(8), 1));
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    indices.push(i, i + 4, j + 4, i, j + 4, j);
  }
  apronGeom.setAttribute('position', new THREE.Float32BufferAttribute(ringPositions, 3));
  apronGeom.setIndex(indices);
  apronGeom.computeVertexNormals();
  const apron = new THREE.Mesh(apronGeom, material);
  apron.receiveShadow = true;
  scene.add(apron);

  const lo = new Int16Array(N),
    hi = new Int16Array(N);
  function sync(core, world) {
    const memory = core.memory.buffer;
    const flags = new Uint8Array(memory, core.world_dirty(world), TILES * TILES);
    const heights = new Int32Array(memory, core.world_height(world), N * N);
    const compact = new Uint8Array(memory, core.world_compact(world), N * N);
    if (!seededDatum) {
      for (let i = 0; i < heights.length; i++) bankDatum.array[i] = heights[i] * 0.001;
      bankDatum.needsUpdate = true;
      seededDatum = true;
    }
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
        packed.array[i]=compact[i];
        pos.setY(i, depth(i) * 0.001);
        normal.setXYZ(i, nx * inv, inv, nz * inv);
      }
      const start = (z * N + lo[z]) * 3,
        count = (hi[z] - lo[z] + 1) * 3;
      pos.addUpdateRange(start, count);
      normal.addUpdateRange(start, count);
      packed.addUpdateRange(start/3,count/3);
      bytes += count * 8 + count/3;
    }
    if (bytes) {
      pos.needsUpdate = normal.needsUpdate = packed.needsUpdate = true;
      core.world_clear_dirty(world);
    }
    return bytes;
  }
  return {
    sync,
    trackPose: (matrix) => trackFrame.value.copy(matrix).invert(),
    inspect: (on) => {
      inspect.value = Number(on);
    },
  };
}

// Reconstruct the dense part of a moving stream from occupied height slices.
// Each parcel contributes its actual loose volume (one unit = 1/64000 m?).
// Empty slices separate flights; the render never draws a line to the floor.
function fallingSheet(scene) {
  const step = 0.072,
    levels = 176,
    sides = 16;
  const volume = new Float64Array(levels),
    sumX = new Float64Array(levels);
  const sumZ = new Float64Array(levels),
    sideSquare = new Float64Array(levels);
  const radiusSum = new Float64Array(levels),
    speedSum = new Float64Array(levels);
  const fields = [volume, sumX, sumZ, sideSquare, radiusSum, speedSum];
  const vertices = levels * sides;
  const dynamic = () =>
    new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const position = dynamic(),
    normal = dynamic(),
    color = dynamic();
  const breakup = new THREE.BufferAttribute(new Float32Array(vertices), 1).setUsage(
    THREE.DynamicDrawUsage,
  );
  const index = new THREE.BufferAttribute(
    new Uint16Array(levels * (sides * 6 + (sides - 2) * 3)),
    1,
  ).setUsage(THREE.DynamicDrawUsage);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', position);
  geometry.setAttribute('normal', normal);
  geometry.setAttribute('color', color);
  geometry.setAttribute('breakup', breakup);
  geometry.setIndex(index);
  geometry.setDrawRange(0, 0);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'attribute float breakup; varying float fallApart; varying vec3 sandPosition;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nsandPosition=position;fallApart=breakup;',
      );
    shader.fragmentShader =
      `varying vec3 sandPosition; varying float fallApart;
      float fleckHash(vec3 p) {p=fract(p*vec3(.1031,.11369,.13787));p+=dot(p,p.yxz+19.19);return fract((p.x+p.y)*p.z);}
      float fleck(vec3 p){
        vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
        return mix(mix(mix(fleckHash(i),fleckHash(i+vec3(1,0,0)),f.x),mix(fleckHash(i+vec3(0,1,0)),fleckHash(i+vec3(1,1,0)),f.x),f.y),
          mix(mix(fleckHash(i+vec3(0,0,1)),fleckHash(i+vec3(1,0,1)),f.x),mix(fleckHash(i+vec3(0,1,1)),fleckHash(i+vec3(1,1,1)),f.x),f.y),f.z);
      }
      ` +
      shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
      // Dust-light and dark grains in the body of the fall. The far view
      // resolves its shaded bulk while the close view resolves its texture.
      float clusters=fleck(sandPosition*vec3(17.,11.,17.))*.60+fleck(sandPosition*vec3(43.,29.,43.))*.40;
      if(clusters<fallApart*.90+.06)discard;
      vec3 cell=floor(sandPosition*190.);
      vec3 hash=fract(cell*vec3(.1031,.1097,.0973));
      hash+=dot(hash,hash.yzx+33.33);
      float grain=fract((hash.x+hash.y)*hash.z);
      float detail=1.-smoothstep(.002,.016,length(fwidth(sandPosition)));
      diffuseColor.rgb*=(.90+.19*clusters)*(1.+(grain-.5)*.44*detail);`,
      );
  };
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Falling granular sheet';
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  scene.add(mesh);
  const phi = Array.from({ length: sides }, (_, i) => [
    Math.cos((i * 2 * Math.PI) / sides),
    Math.sin((i * 2 * Math.PI) / sides),
  ]);
  const lip = new THREE.Vector3(),
    across = new THREE.Vector3(),
    inward = new THREE.Vector3();
  let tooth;
  return function update(data, mass, n) {
    mesh.visible = false;
    if (!n) return;
    tooth ??= scene.getObjectByName('Centre cutting tooth');
    let high = -Infinity,
      low = Infinity;
    for (let i = 0; i < n; i++) {
      const j = i * 7,
        r = Math.cbrt(mass[j + 3] / 64000);
      const reach = Math.max(step, r * 0.55 + Math.abs(data[j + 5]) * 0.014);
      high = Math.max(high, data[j + 1] + reach);
      low = Math.min(low, data[j + 1] - reach);
    }
    if (tooth) {
      tooth.updateWorldMatrix(true, false);
      lip.setFromMatrixPosition(tooth.matrixWorld);
      across.setFromMatrixColumn(tooth.matrixWorld, 2).setY(0).normalize();
      inward.setFromMatrixColumn(tooth.matrixWorld, 0);
    } else {
      across.set(0, 0, 1);
      lip.set(0, -100, 0);
      inward.set(0, 0, 0);
    }
    const sx = across.x,
      sz = across.z,
      nx = sz,
      nz = -sx;
    let attachedMass = 0;
    for (let i = 0; i < n; i++) {
      const j = i * 7,
        dx = data[j] - lip.x,
        dz = data[j + 2] - lip.z;
      if (
        Math.abs(dx * sx + dz * sz) < 0.6 &&
        Math.abs(dx * nx + dz * nz) < 0.17 &&
        Math.abs(data[j + 1] - lip.y) < 0.13
      )
        attachedMass += mass[j + 3];
    }
    // At the lip, merge into the bowl just behind the tooth tips. Once input
    // ceases the upper stream falls away with its last actual particles.
    if (attachedMass > 0) high = lip.y + 0.045 + Math.max(0, inward.y * 0.065);
    const rows = Math.min(levels, Math.max(2, Math.ceil((high - low) / step) + 1));
    for (const f of fields) f.fill(0, 0, rows);
    for (let i = 0; i < n; i++) {
      const j = i * 7,
        v = mass[j + 3] / 64000,
        r = Math.cbrt(v),
        py = data[j + 1],
        vy = data[j + 5];
      const reach = Math.max(step, r * 0.55 + Math.abs(vy) * 0.014);
      const first = Math.max(0, Math.floor((high - py - reach) / step));
      const last = Math.min(rows - 1, Math.ceil((high - py + reach) / step));
      for (let k = first; k <= last; k++) {
        const dy = high - k * step - py;
        const w = (v * Math.max(0, 1 - Math.abs(dy) / reach) * step) / reach;
        const t = vy < -0.1 ? Math.max(-0.022, Math.min(0.022, dy / vy)) : 0;
        const px = data[j] + t * data[j + 4],
          pz = data[j + 2] + t * data[j + 6],
          s = px * sx + pz * sz;
        volume[k] += w;
        sumX[k] += w * px;
        sumZ[k] += w * pz;
        sideSquare[k] += w * s * s;
        radiusSum[k] += w * r;
        speedSum[k] += w * Math.abs(vy);
      }
    }
    // The departure ring is bounded by the cutting edge width and by the
    // quantity that is actually exiting. Interpolation stops at the first gap.
    if (attachedMass > 0 && rows > 1 && volume[1] > 0) {
      const v = Math.max(volume[0], volume[1] * 0.6);
      const s = lip.x * sx + lip.z * sz;
      volume[0] = v;
      sumX[0] = v * (lip.x + 0.06 * inward.x);
      sumZ[0] = v * (lip.z + 0.06 * inward.z);
      const half = Math.min(0.41, 0.12 + 0.28 * Math.sqrt(Math.min(1, attachedMass / 4500)));
      sideSquare[0] = v * (s * s + (half * 0.52) ** 2);
      radiusSum[0] = v * 0.1;
      speedSum[0] = 0;
    }
    let vert = 0,
      indices = 0,
      prev = -1,
      previousX = 0,
      previousZ = 0;
    function cap(base, upward) {
      for (let edge = 1; edge < sides - 1; edge++) {
        index.array[indices++] = base;
        index.array[indices++] = base + edge + (upward ? 0 : 1);
        index.array[indices++] = base + edge + (upward ? 1 : 0);
      }
    }
    for (let k = 0; k < rows; k++) {
      const v = volume[k];
      if (v < 0.00024) {
        if (prev >= 0) cap(prev, false);
        prev = -1;
        continue;
      }
      const y = high - step * k;
      let cx = sumX[k] / v,
        cz = sumZ[k] / v;
      const meanSide = cx * sx + cz * sz;
      const variance = Math.max(0, sideSquare[k] / v - meanSide * meanSide);
      let width = Math.min(
        0.54,
        Math.max(0.037, Math.sqrt(variance) * 1.7 + (0.42 * radiusSum[k]) / v),
      );
      // Weighted neighboring centers remove the sampling jitter of 1-4
      // computational parcels per tick; keep separate jets disconnected.
      let weight = 1,
        smoothX = cx,
        smoothZ = cz;
      for (let other = k - 2; other <= k + 2; other++) {
        if (other === k || other < 0 || other >= rows || volume[other] < 0.00024 || k === 0)
          continue;
        const qx = sumX[other] / volume[other],
          qz = sumZ[other] / volume[other];
        if (Math.hypot(qx - cx, qz - cz) > 0.36) continue;
        const w = (3 - Math.abs(other - k)) * 0.3;
        smoothX += qx * w;
        smoothZ += qz * w;
        weight += w;
      }
      cx = smoothX / weight;
      cz = smoothZ / weight;
      const speed = speedSum[k] / v,
        fall = THREE.MathUtils.smoothstep(speed, 1.0, 5.0);
      const depth = Math.max(0.012, Math.min(0.15, v / (step * Math.PI * width)));
      const ridge = THREE.MathUtils.smoothstep(v, 0.0003, 0.004);
      width *= 0.7 + 0.3 * ridge;
      const loose = Math.min(1, fall * 0.87 + (1 - ridge) * 0.28);
      if (prev >= 0 && Math.hypot(cx - previousX, cz - previousZ) > 0.23) {
        cap(prev, false);
        prev = -1;
      }
      const start = vert;
      for (let edge = 0; edge < sides; edge++) {
        const [co, si] = phi[edge];
        const corrugation = 0.78 + 0.22 * Math.cos(co * 12 + y * 3 + cx + cz);
        const a = co * width,
          b = si * depth * corrugation;
        position.setXYZ(vert, cx + sx * a + nx * b, y, cz + sz * a + nz * b);
        const ns = co * depth,
          nd = si * width,
          inv = 1 / Math.max(0.0001, Math.hypot(ns, nd));
        normal.setXYZ(vert, (sx * ns + nx * nd) * inv, 0.05, (sz * ns + nz * nd) * inv);
        const lit = 0.87 + 0.13 * corrugation;
        color.setXYZ(vert, 0.66 * lit, 0.404 * lit, 0.175 * lit);
        breakup.setX(vert, Math.min(1, loose + 0.13 * Math.abs(co)));
        vert++;
      }
      if (prev < 0) {
        cap(start, true);
      } else
        for (let edge = 0; edge < sides; edge++) {
          const a = prev + edge,
            b = prev + ((edge + 1) % sides);
          const c = start + edge,
            d = start + ((edge + 1) % sides);
          index.array[indices++] = a;
          index.array[indices++] = c;
          index.array[indices++] = b;
          index.array[indices++] = b;
          index.array[indices++] = c;
          index.array[indices++] = d;
        }
      previousX = cx;
      previousZ = cz;
      prev = start;
    }
    if (prev >= 0) cap(prev, false);
    geometry.setDrawRange(0, indices);
    mesh.visible = indices > 0;
    if (!indices) return;
    for (const attr of [position, normal, color, breakup, index]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, attr === index ? indices : vert * attr.itemSize);
      attr.needsUpdate = true;
    }
  };
}

export function createStream(scene) {
  // Each tracked parcel carries many sub-grains in one instanced point draw. The
  // ballistic segment interpolates the fall between 60 Hz emissions.
  const sheet = fallingSheet(scene);
  const count = 144,
    geom = new THREE.InstancedBufferGeometry(),
    seeds = new Float32Array(count * 3);
  let seed = 73517;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < seeds.length; i++) seeds[i] = random();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(seeds, 3));
  const centers = new THREE.InstancedBufferAttribute(new Float32Array(640 * 4), 4).setUsage(
    THREE.DynamicDrawUsage,
  );
  const velocities = new THREE.InstancedBufferAttribute(new Float32Array(640 * 3), 3).setUsage(
    THREE.DynamicDrawUsage,
  );
  geom.setAttribute('center', centers);
  geom.setAttribute('velocity', velocities);
  geom.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    uniforms: { pixelHeight: { value: 900 } },
    transparent: true,
    depthWrite: false,
    vertexShader: `attribute vec4 center; attribute vec3 velocity; uniform float pixelHeight; varying float shade;
      void main(){float seed=fract(dot(velocity.xz,vec2(12.123,7.173))+center.w*37.1);
        vec3 r=fract(position+vec3(seed,seed*.71,seed*.29));
        float back=(r.y-.5)*.0167;
        vec3 p=center.xyz+velocity*back;
        vec2 disc=vec2(cos(r.x*6.28318),sin(r.x*6.28318))*sqrt(r.z)*center.w*.80;
        p.xz+=disc;p.y+=(r.y-.5)*center.w*.91;
        vec4 eye=modelViewMatrix*vec4(p,1.); gl_Position=projectionMatrix*eye;
        gl_PointSize=clamp(pixelHeight*projectionMatrix[1][1]*(.0026+.013*r.z)*clamp(center.w*5.6,.38,1.25)/max(.3,-eye.z),1.1,6.);
        shade=r.x*.65+r.z*.35;}`,
    fragmentShader: `varying float shade; void main(){float d=length(gl_PointCoord*2.-1.);
      if(d>1.)discard;
      vec2 q=gl_PointCoord*2.-1.;
      float lit=.72+.30*sqrt(max(0.,1.-d*d))-.14*q.x+.14*q.y;
      gl_FragColor=vec4(mix(vec3(.28,.145,.055),vec3(.67,.438,.227),shade)*lit,1.-smoothstep(.73,1.,d));
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  });
  const grains = new THREE.Points(geom, mat);
  grains.frustumCulled = false;
  scene.add(grains);
  return function sync(core, world) {
    const n = core.world_air_len(world);
    geom.instanceCount = n;
    grains.visible = n > 0;
    if (!n) {
      sheet(null, null, 0);
      return;
    }
    mat.uniforms.pixelHeight.value = scene.userData.renderHeight ?? 900;
    const ptr = core.world_air(world),
      buf = core.memory.buffer;
    const data = new Float32Array(buf, ptr, n * 7),
      mass = new Int32Array(buf, ptr, n * 7);
    sheet(data, mass, n);
    for (let i = 0; i < n; i++) {
      const j = i * 7;
      centers.setXYZW(i, data[j], data[j + 1], data[j + 2], Math.cbrt(mass[j + 3] / 64000));
      velocities.setXYZ(i, data[j + 4], data[j + 5], data[j + 6]);
    }
    for (const attribute of [centers, velocities]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, n * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  };
}
