#!/usr/bin/env node
// Entry point. `--daemon` runs the long-lived server; anything else is a CLI call
// (which will auto-start the daemon on demand).

import { runCli } from './cli.js';
import { runDaemon } from './daemon.js';

const argv = process.argv.slice(2);

if (argv[0] === '--daemon') {
  runDaemon().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  });
} else {
  runCli(argv).catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
