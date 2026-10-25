import { build } from 'esbuild';
import { cp, mkdir, readFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
await build({
  entryPoints: ['src/content.ts', 'src/source-guard.ts', 'src/popup.ts', 'src/background.ts'],
  outdir: 'dist', bundle: true, format: 'iife', target: 'chrome111',
  sourcemap: true, legalComments: 'none'
});
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
console.log(`Built ${manifest.name} ${manifest.version} -> dist/`);
