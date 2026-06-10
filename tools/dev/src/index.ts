#!/usr/bin/env node
/**
 * pnpm tools-dev entry point.
 *
 * Subcommands:
 *   start   Spawn daemon + web as detached children.
 *   stop    Kill the children.
 *   status  Show runtime state + probe /api/health.
 *   run     Foreground run (dev mode). Ctrl-C kills both.
 *   logs    Print log paths or dump a single log.
 *   check   Probe /api/health, exit 0/1.
 *
 * Common flags:
 *   --daemon-port <n>   default 7456
 *   --web-port    <n>   default 3000
 *   --namespace   <ns>  default "default"
 */

import {
  parseArgs,
  cmdStart,
  cmdStop,
  cmdStatus,
  cmdRun,
  cmdLogs,
  cmdCheck,
} from './ports.js';

const HELP = `pnpm tools-dev <command> [flags]

Commands:
  start         Spawn daemon + web as detached children
  stop          Kill the children
  status        Show runtime state + probe /api/health
  run web       Foreground run for development
  logs          Print log paths (--daemon / --web to dump one)
  check         Probe /api/health, exit 0/1

Flags:
  --daemon-port <n>   default 7456
  --web-port    <n>   default 3000
  --namespace   <ns>  default "default"
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  let code = 0;
  switch (args.cmd) {
    case 'start':
      code = await cmdStart(args);
      break;
    case 'stop':
      code = await cmdStop(args);
      break;
    case 'status':
      code = await cmdStatus(args);
      break;
    case 'run':
      code = await cmdRun(args);
      break;
    case 'logs':
      code = await cmdLogs(args);
      break;
    case 'check':
      code = await cmdCheck(args);
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(HELP);
      code = 0;
      break;
    default:
      process.stderr.write(`unknown command: ${args.cmd}\n\n${HELP}`);
      code = 2;
  }
  process.exit(code);
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
