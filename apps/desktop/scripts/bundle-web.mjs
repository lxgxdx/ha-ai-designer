#!/usr/bin/env node
/**
 * Bundle the Next.js web app for inclusion in the desktop .exe.
 *
 * Mirrors `bundle-daemon.mjs` for the web side. Next.js needs:
 *   - .next/   (the built output)
 *   - next.config.mjs (read at `next start` startup)
 *   - node_modules/ with `next` and its transitive deps
 *     (react, react-dom, scheduler, etc.)
 *
 * `pnpm deploy --prod --legacy` produces a flat node_modules/ with
 * no pnpm symlinks — exactly what electron-builder needs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const outDir = resolve(__dirname, '..', 'build', 'web-bundle');
const webDir = resolve(repoRoot, 'apps', 'web');
const webNextSrc = join(webDir, '.next');
const webConfigSrc = join(webDir, 'next.config.mjs');

function run(cmd, args, opts = {}) {
  console.log(`[bundle-web] $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) {
    console.error(`[bundle-web] ${cmd} exited with ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

// 1. next build — produces .next/
run('pnpm', ['--filter', '@ha-designer/web', 'build'], { cwd: repoRoot });

if (!existsSync(webNextSrc)) {
  console.error(`[bundle-web] expected .next/ at ${webNextSrc} but none found`);
  process.exit(1);
}

// 2. pnpm deploy — self-contained tree with prod deps
if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}
run(
  'pnpm',
  ['--filter', '@ha-designer/web', 'deploy', '--prod', '--legacy', outDir],
  { cwd: repoRoot },
);

// 3. Copy built .next/ into the bundle
cpSync(webNextSrc, join(outDir, '.next'), { recursive: true });
console.log(`[bundle-web] copied ${webNextSrc} → ${outDir}/.next`);

// 4. Copy next.config.mjs (read at next start)
if (existsSync(webConfigSrc)) {
  cpSync(webConfigSrc, join(outDir, 'next.config.mjs'));
  console.log(`[bundle-web] copied next.config.mjs`);
}

// 5. Patch deployed package.json scripts so `npm start` would
//    invoke next directly (helpful for debugging the bundle).
const deployedPkgPath = join(outDir, 'package.json');
const deployedPkg = JSON.parse(readFileSync(deployedPkgPath, 'utf8'));
deployedPkg.scripts = {
  ...deployedPkg.scripts,
  start: 'next start',
};
writeFileSync(deployedPkgPath, JSON.stringify(deployedPkg, null, 2));

// 6. Sanity check — confirm `next` is in node_modules with a real dist/
const nextBin = join(outDir, 'node_modules', 'next', 'dist', 'bin', 'next');
if (!existsSync(nextBin)) {
  console.error(
    `[bundle-web] FATAL: next bin missing at ${nextBin}.\n` +
      `The packaged web will fail to start. ` +
      `Check that pnpm deploy --prod captured it.`,
  );
  process.exit(1);
}
console.log(`[bundle-web] OK: next bin present at ${nextBin}`);

console.log(`[bundle-web] done. bundle at ${outDir}`);
