import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

execFileSync('cargo', ['build', '--lib', '--release', '--target', 'wasm32-unknown-unknown'], {
  stdio: 'inherit',
});
const result = await build({
  entryPoints: ['web/game.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2021',
  write: false,
  legalComments: 'inline',
});
const [shell, css, wasm, license] = await Promise.all([
  readFile('web/shell.html', 'utf8'),
  readFile('web/style.css', 'utf8'),
  readFile('target/wasm32-unknown-unknown/release/sandlab.wasm'),
  readFile('node_modules/three/LICENSE', 'utf8'),
]);
let html = shell
  .replace('/*__CSS__*/', () => css)
  .replace('__WASM64__', () => wasm.toString('base64'))
  .replace('/*__GAME__*/', () => result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'));
html = html.replace('</head>', () => '<!-- Three.js license\n' + license + '\n-->\n</head>');
await writeFile('index.html', html);
console.log('Single-file release:', Buffer.byteLength(html), 'bytes including WASM and Three.js');
