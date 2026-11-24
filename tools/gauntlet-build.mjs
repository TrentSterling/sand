// Build a private copy of the game with deterministic tick and camera controls.
// The shipped game and index.html remain untouched.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [side, ref = '677fca8'] = process.argv.slice(2);
if (!['baseline', 'candidate'].includes(side)) throw Error('Expected baseline or candidate');
const reviewRoot = resolve(root, process.env.SAND_GAUNTLET_DIR || '.work/gauntlet');
const work = join(reviewRoot, 'private', side);
const source = join(work, 'source', 'web');
await mkdir(source, { recursive: true });
const git = (...args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 ** 2 });
const baseline = side === 'baseline';
const extract = (file) => baseline ? git('show', `${ref}:${file}`) : readFile(join(root, file));
const files = baseline
  ? git('ls-tree', '--name-only', `${ref}:web`).toString().trim().split(/\r?\n/)
  : await readdir(join(root, 'web'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = {};
for (const file of files) {
  const bytes = await extract('web/' + file);
  sourceHashes[file] = hash(bytes);
  await writeFile(join(source, file), bytes);
}
const release = await extract('index.html');
const packedWasm = release.toString().match(/<script\s+id="wasm"[^>]*>([\s\S]*?)<\/script>/)?.[1]?.trim();
if (!packedWasm) throw Error('Embedded WASM missing');
const wasm = Buffer.from(packedWasm, 'base64');
if (!baseline) {
  const compiled = await readFile(join(root, 'target/wasm32-unknown-unknown/release/sandlab.wasm'));
  if (!compiled.equals(wasm)) throw Error('Run the game build before capturing the candidate.');
}

// This function is inserted verbatim inside start(), after the original reset.
// It closes over the game's own state. Only time and camera are substituted.
function installReviewBridge() {
  const canvas = renderer.domElement;
  const gl = renderer.getContext();
  const motionFrame = document.createElement('canvas');
  motionFrame.width = 800;
  motionFrame.height = 480;
  const motionContext = motionFrame.getContext('2d', { alpha: false });
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererName = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const sync = () => {
    const changed = terrain.sync(core, w);
    stream(core, w);
    if (changed) treads.refresh((x, z) => core.world_ground(w, x, z));
    scene.updateMatrixWorld(true);
  };
  function state() {
    return {
      frame, action, manual, pose: { ...p }, base: { ...base }, trackYaw,
      tip: tip.toArray(), rootEuler: rig.root.rotation.toArray().slice(0, 3),
      massError: core.world_balance(w), load: core.world_load(w), bay: core.world_bay(w),
      air: core.world_air_len(w),
    };
  }
  function advance(ticks) {
    for (let n = 0; n < ticks; n++) tick();
    sync();
    return state();
  }
  function frameFor(spec) {
    const y = trackYaw + (spec.chassis ? 0 : p.yaw);
    const rotate = (v) => v.applyAxisAngle(new THREE.Vector3(0, 1, 0), y);
    const look = new THREE.Vector3(...spec.center);
    if (spec.tip) {
      rotate(look).add(tip);
    } else {
      rotate(look).add(new THREE.Vector3(base.x, base.y, base.z));
    }
    const pos = rotate(new THREE.Vector3(...spec.eye)).add(look);
    return { look: look.toArray(), eye: pos.toArray(), width: spec.width, isolate: !!spec.isolate };
  }
  function photograph(f, motion = false) {
    sync();
    const ortho = Boolean(f.width);
    const aspect = canvas.width / canvas.height;
    const lens = ortho
      ? new THREE.OrthographicCamera(-f.width/2, f.width/2, f.width/(2*aspect), -f.width/(2*aspect), 0.05, 220)
      : new THREE.PerspectiveCamera(38, aspect, 0.05, 220);
    lens.position.fromArray(f.eye);
    lens.lookAt(new THREE.Vector3(...f.look));
    lens.updateMatrixWorld(true);
    const hidden = [];
    const bg = scene.background, fog = scene.fog;
    if (f.isolate) {
      scene.background = new THREE.Color('#909996');
      scene.fog = null;
      for (const child of scene.children) {
        if (child.visible && child !== rig.root && !child.isLight) {
          hidden.push(child);
          child.visible = false;
        }
      }
    }
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, lens);
    if (motion) motionContext.drawImage(canvas, 0, 0, motionFrame.width, motionFrame.height);
    const image = motion ? motionFrame.toDataURL('image/jpeg', 0.94) : canvas.toDataURL('image/png');
    const pixels = image.slice(image.indexOf(',') + 1);
    for (const child of hidden) child.visible = true;
    scene.background = bg;
    scene.fog = fog;
    renderer.shadowMap.needsUpdate = true;
    return pixels;
  }
  window.gauntlet = {
    state, advance, frameFor, photograph, rendererName,
    command(name) { document.querySelector(`[data-action="${name}"]`).click(); },
    finish() {
      let count = 0;
      while (action && count < 1200) { tick(); count++; }
      if (action) throw Error('Action did not finish.');
      sync();
      return state();
    },
    reset() { byId('reset').click(); sync(); return state(); },
    key(code, down) {
      document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
    },
    motionBatch({ lens, count, schedule }) {
      const images = [];
      for (let i = 0; i < count; i++) {
        const next = schedule[frame];
        if (next) {
          if (action) throw Error('Previous action still running at capture tick ' + frame);
          document.querySelector(`[data-action="${next}"]`).click();
        }
        images.push(photograph(lens, true));
        for (let sub = 0; sub < 3; sub++) tick();
      }
      return images;
    },
  };
}
const gamePath = join(source, 'game.js');
const original = await readFile(gamePath, 'utf8');
const anchor = "  reset();\n  window.addEventListener('resize'";
const normalized = original.replaceAll('\r\n', '\n');
if (normalized.split(anchor).length !== 2) throw Error('Game startup anchor changed. Check the original start() before running.');
const insertion = "  reset();\n  (" + installReviewBridge.toString() + ")();\n  return;\n  window.addEventListener('resize'";
await writeFile(gamePath, normalized.replace(anchor, () => insertion));
const bundle = await build({
  entryPoints: [gamePath], bundle: true, write: false, format: 'iife', target: 'es2021',
  minify: true, legalComments: 'inline', absWorkingDir: root,
});
const html = (await readFile(join(source, 'shell.html'), 'utf8'))
  .replace('/*__CSS__*/', await readFile(join(source, 'style.css'), 'utf8'))
  .replace('__WASM64__', () => packedWasm)
  .replace('/*__GAME__*/', () => bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'));
await writeFile(join(work, 'capture.html'), html);
await writeFile(join(work, 'source.json'), JSON.stringify({
  revision: baseline ? git('rev-parse', ref).toString().trim() : 'working tree',
  indexSha256: hash(release), embeddedWasmSha256: hash(wasm), sourceHashes,
}, null, 2));
