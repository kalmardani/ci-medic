#!/usr/bin/env node
// Entry point. The SQLite experimental warning is the only warning filtered out.
import { main } from '../src/cli.js';

process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

const code = await main(process.argv.slice(2));
process.exitCode = code;
