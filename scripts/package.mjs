import { zipSync } from 'fflate';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (manifest.version !== pkg.version) throw new Error('Manifest and package versions must match');

// Explicit entries keep unrelated or stale dist files out of public releases.
const entries = [
  'manifest.json', 'popup.html', 'popup.css',
  'background.js', 'content.js', 'popup.js', 'source-guard.js'
];
const files = {};
for (const entry of entries) files[entry] = new Uint8Array(await readFile(resolve('dist', entry)));
files['LICENSE'] = new Uint8Array(await readFile('LICENSE'));
await mkdir('release', { recursive: true });
const path = `release/${pkg.name}-v${pkg.version}.zip`;
await writeFile(path, zipSync(files, { level: 9 }));
console.log(`Packaged ${path} (${Object.keys(files).length} files; manifest.json at ZIP root)`);
