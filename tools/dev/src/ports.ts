/**
 * Subcommand implementations.
 *
 * `start`  — spawn daemon + web as detached children, write PIDs to .runtime.json
 * `stop`   — kill PIDs, clear state
 * `status` — read .runtime.json, ping /api/health
 * `run`    — foreground run, used during dev (kills with Ctrl-C)
 * `logs`   — tail logs (placeholder: prints path)
 * `check`  — curl /api/health, exit 0/1
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDirs, REPO_ROOT, writeState, readState, clearState } from './runtime.js';

const DEFAULT_DAEMON_PORT = 7456;
const DEFAULT_WEB_PORT = 3000;
const DEFAULT_NS = 'default';

/**
 * Spawn pnpm in a way that works on Windows + POSIX.
 *
 * On Windows, `pnpm` is shipped as `pnpm.cmd` in the npm global prefix and
 * is NOT on PATH for non-interactive Node child processes by default.
 * Using `shell: true` lets the OS resolve the .cmd shim through PATHEXT.
 * On POSIX it just runs `/bin/sh -c 'pnpm ...'` which is harmless.
 *
 * We also explicitly include the npm global bin in PATH so the shim
 * resolves even when tools-dev is invoked from a context where the
 * global prefix is not on PATH (e.g. some IDE-launched terminals).
 */
function spawnPnpm(
  args: string[],
  options: Parameters<typeof spawn>[2],
): ReturnType<typeof spawn> {
  const npmBin = join(
    process.env.APPDATA ?? process.env.HOME ?? '',
    'npm',
  );
  const augmentedEnv = {
    ...process.env,
    ...(options && 'env' in options ? options.env : {}),
    PATH: [process.env.PATH, npmBin].filter(Boolean).join(
      process.platform === 'win32' ? ';' : ':',
    ),
  };
  return spawn('pnpm', args, {
    ...options,
    env: augmentedEnv,
    shell: process.platform === 'win32',
    windowsHide: true,
  });
}

export interface ParsedArgs {
  cmd: string;
  flags: Record<string, string | boolean>;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [, , cmd = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, flags, positional };
}

function numFlag(flags: Record<string, string | boolean>, key: string, fallback: number): number {
  const v = flags[key];
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function strFlag(
  flags: Record<string, string | boolean>,
  key: string,
  fallback: string,
): string {
  const v = flags[key];
  return typeof v === 'string' ? v : fallback;
}

export async function cmdStart(args: ParsedArgs): Promise<number> {
  const ns = strFlag(args.flags, 'namespace', DEFAULT_NS);
  const daemonPort = numFlag(args.flags, 'daemon-port', DEFAULT_DAEMON_PORT);
  const webPort = numFlag(args.flags, 'web-port', DEFAULT_WEB_PORT);
  ensureDirs(ns);

  const daemonLog = join(REPO_ROOT, 'data', 'logs', ns, 'daemon.log');
  const webLog = join(REPO_ROOT, 'data', 'logs', ns, 'web.log');

  const daemonProc = spawnPnpm(
    ['--filter', '@ha-designer/daemon', 'run', 'dev'],
    {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HA_DAEMON_PORT: String(daemonPort),
        HA_DATA_DIR: join(REPO_ROOT, 'data'),
        HA_REPO_ROOT: REPO_ROOT,
        HA_LOG_PRETTY: '1',
        NODE_ENV: 'development',
      },
    },
  );
  pipeToFile(daemonProc, daemonLog);

  const webProc = spawnPnpm(
    ['--filter', '@ha-designer/web', 'run', 'dev'],
    {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HA_DAEMON_PORT: String(daemonPort),
        HA_DATA_DIR: join(REPO_ROOT, 'data'),
        HA_REPO_ROOT: REPO_ROOT,
        HA_WEB_PORT: String(webPort),
        NODE_ENV: 'development',
      },
    },
  );
  pipeToFile(webProc, webLog);

  writeState({
    namespace: ns,
    daemonPort,
    webPort,
    daemonPid: daemonProc.pid,
    webPid: webProc.pid,
    startedAt: new Date().toISOString(),
  });

  console.log(`✓ started (ns=${ns})`);
  console.log(`  daemon: pid=${daemonProc.pid} port=${daemonPort}  log=${daemonLog}`);
  console.log(`  web:    pid=${webProc.pid} port=${webPort}  log=${webLog}`);
  console.log(`  url:    http://localhost:${webPort}`);

  daemonProc.unref();
  webProc.unref();
  return 0;
}

function pipeToFile(
  proc: ReturnType<typeof spawn>,
  file: string,
): void {
  // Lazy import to keep top of file light.
  import('node:fs').then(({ createWriteStream }) => {
    const stream = createWriteStream(file, { flags: 'a' });
    proc.stdout?.pipe(stream);
    proc.stderr?.pipe(stream);
  });
}

export async function cmdStop(_args: ParsedArgs): Promise<number> {
  const state = readState();
  if (!state || (!state.daemonPid && !state.webPid)) {
    console.log('nothing to stop (no runtime state)');
    return 0;
  }
  for (const pid of [state.daemonPid, state.webPid]) {
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`✓ sent SIGTERM to pid ${pid}`);
      } catch (e) {
        console.warn(`! could not kill ${pid}: ${(e as Error).message}`);
      }
    }
  }
  clearState();
  return 0;
}

export async function cmdStatus(_args: ParsedArgs): Promise<number> {
  const state = readState();
  if (!state) {
    console.log('not running (no runtime state)');
    return 0;
  }
  console.log(JSON.stringify(state, null, 2));

  // Probe daemon health.
  try {
    const res = await fetch(`http://127.0.0.1:${state.daemonPort}/api/health`);
    console.log(`daemon /api/health → ${res.status}`);
  } catch (e) {
    console.log(`daemon unreachable: ${(e as Error).message}`);
  }
  return 0;
}

/**
 * Foreground run — spawns daemon + web and waits. Ctrl-C kills both.
 * This is the recommended mode for dev; start/stop are for CI or background use.
 */
export async function cmdRun(args: ParsedArgs): Promise<number> {
  const target = args.positional[0] ?? 'web';
  if (target !== 'web') {
    console.error(`run: unsupported target "${target}" (only "web" is implemented in v0.1)`);
    return 2;
  }
  const daemonPort = numFlag(args.flags, 'daemon-port', DEFAULT_DAEMON_PORT);
  const webPort = numFlag(args.flags, 'web-port', DEFAULT_WEB_PORT);

  const procs: Array<{ name: string; proc: ReturnType<typeof spawn> }> = [];

  procs.push({
    name: 'daemon',
    proc: spawnPnpm(['--filter', '@ha-designer/daemon', 'run', 'dev'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        HA_DAEMON_PORT: String(daemonPort),
        HA_DATA_DIR: join(REPO_ROOT, 'data'),
        HA_REPO_ROOT: REPO_ROOT,
        HA_LOG_PRETTY: '1',
        NODE_ENV: 'development',
      },
    }),
  });

  procs.push({
    name: 'web',
    proc: spawnPnpm(['--filter', '@ha-designer/web', 'run', 'dev'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        HA_DAEMON_PORT: String(daemonPort),
        HA_DATA_DIR: join(REPO_ROOT, 'data'),
        HA_REPO_ROOT: REPO_ROOT,
        HA_WEB_PORT: String(webPort),
        NODE_ENV: 'development',
      },
    }),
  });

  const shutdown = (signal: string) => {
    console.log(`\nreceived ${signal}, shutting down children…`);
    for (const { proc } of procs) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // best-effort
      }
    }
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return new Promise<number>((resolve) => {
    let exited = 0;
    for (const { proc } of procs) {
      proc.on('exit', (code) => {
        exited++;
        if (exited === procs.length) {
          resolve(code ?? 0);
        }
      });
    }
  });
}

export async function cmdLogs(args: ParsedArgs): Promise<number> {
  const ns = strFlag(args.flags, 'namespace', DEFAULT_NS);
  const which = args.flags['daemon'] ? 'daemon' : args.flags['web'] ? 'web' : null;
  const dir = join(REPO_ROOT, 'data', 'logs', ns);
  if (which) {
    const file = join(dir, `${which}.log`);
    if (!existsSync(file)) {
      console.log(`(no log file at ${file})`);
      return 0;
    }
    process.stdout.write(readFileSync(file, 'utf8'));
    return 0;
  }
  console.log(`logs at: ${dir}`);
  console.log(`  --daemon → ${join(dir, 'daemon.log')}`);
  console.log(`  --web    → ${join(dir, 'web.log')}`);
  return 0;
}

export async function cmdCheck(args: ParsedArgs): Promise<number> {
  const port = numFlag(args.flags, 'daemon-port', DEFAULT_DAEMON_PORT);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (!res.ok) {
      console.error(`daemon /api/health → ${res.status}`);
      return 1;
    }
    const body = (await res.json()) as { service: string; ts: string };
    console.log(`✓ ${body.service} @ ${body.ts}`);
    return 0;
  } catch (e) {
    console.error(`✗ daemon unreachable: ${(e as Error).message}`);
    return 1;
  }
}
