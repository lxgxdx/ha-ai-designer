#!/usr/bin/env node
/**
 * Bundle the daemon for inclusion in the desktop .exe.
 *
 * What this does:
 *   1. tsc — produces apps/daemon/dist/server.js (the compiled daemon)
 *   2. pnpm deploy --prod --legacy — creates a SELF-CONTAINED copy of
 *      the daemon at ./build/daemon-bundle/ with all production
 *      deps (better-sqlite3 native binary, express, ws, pino, etc.)
 *      resolved as real folders instead of pnpm symlinks.
 *   3. Replace the deployed src/ with the built dist/. (pnpm deploy
 *      only includes what's in `files` or `src` by default; we want
 *      the compiled JS, not the TS sources.)
 *   4. Update the deployed package.json's `main` field to point at
 *      dist/server.js, and add a `bin` so `ha-ai-designer` works
 *      from the bundle.
 *
 * Why we need this:
 *   electron-builder's `extraResources` walks a source tree and
 *   copies it. With pnpm's symlinked node_modules, copying without
 *   dereferencing gives broken symlinks in the packaged app (the
 *   rel paths point back to the dev tree). `pnpm deploy` produces
 *   a flat, self-contained tree that electron-builder can copy
 *   verbatim.
 *
 * Same approach the add-on Dockerfile used (the only deploy path
 * that worked end-to-end for the daemon).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const outDir = resolve(__dirname, '..', 'build', 'daemon-bundle');
const daemonDistSrc = resolve(repoRoot, 'apps', 'daemon', 'dist');

function run(cmd, args, opts = {}) {
  console.log(`[bundle-daemon] $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) {
    console.error(`[bundle-daemon] ${cmd} exited with ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

// 1. tsc — compile the daemon
run('pnpm', ['--filter', '@ha-designer/daemon', 'build'], { cwd: repoRoot });

if (!existsSync(daemonDistSrc)) {
  console.error(`[bundle-daemon] expected compiled output at ${daemonDistSrc} but none found`);
  process.exit(1);
}

// 2. pnpm deploy — self-contained tree with all prod deps
if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}
run(
  'pnpm',
  ['--filter', '@ha-designer/daemon', 'deploy', '--prod', '--legacy', outDir],
  { cwd: repoRoot },
);

// 3. Replace deployed src/ with built dist/
const deployedSrc = join(outDir, 'src');
if (existsSync(deployedSrc)) {
  rmSync(deployedSrc, { recursive: true, force: true });
}
const deployedDist = join(outDir, 'dist');
cpSync(daemonDistSrc, deployedDist, { recursive: true });
console.log(`[bundle-daemon] copied ${daemonDistSrc} → ${deployedDist}`);

// 4. Patch deployed package.json: point main at dist/server.js
const deployedPkgPath = join(outDir, 'package.json');
const deployedPkg = JSON.parse(readFileSync(deployedPkgPath, 'utf8'));
deployedPkg.main = './dist/server.js';
// Keep the bin entry for the `ha-ai-designer` CLI (desktop main uses
// process.execPath + the bundled server.js directly, but the bin
// entry is useful for command-line users who install the .exe).
writeFileSync(deployedPkgPath, JSON.stringify(deployedPkg, null, 2));
console.log(`[bundle-daemon] patched ${deployedPkgPath} (main → ./dist/server.js)`);

// 5. Sanity check — make sure the native binary made it.
const nativeBin = join(
  outDir,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node',
);
if (!existsSync(nativeBin)) {
  console.error(
    `[bundle-daemon] FATAL: better-sqlite3 native binary missing at ${nativeBin}.\n` +
      `The packaged daemon will crash on require('better-sqlite3'). ` +
      `Check that pnpm deploy --prod captured it.`,
  );
  process.exit(1);
}
console.log(`[bundle-daemon] OK: native binary present at ${nativeBin}`);

console.log(`[bundle-daemon] done. bundle at ${outDir}`);
