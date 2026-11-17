// Synthetic subprocess probe: block archive/env-file access and network/pg clients.
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register, syncBuiltinESMExports } from 'node:module';

function rejectObservedFile(value) {
  let filename;
  try {
    if (typeof value === 'string') filename = path.resolve(value);
    else if (value instanceof URL && value.protocol === 'file:') filename = path.resolve(fileURLToPath(value));
  } catch { return; }
  if (filename === process.env.SYNTHETIC_ARCHIVE_PATH || filename === process.env.SYNTHETIC_ENV_PATH) {
    process.stderr.write('SYNTHETIC_FILE_IO_BLOCKED\n');
    throw new Error('synthetic restore file access blocked');
  }
}

for (const name of ['readFileSync', 'openSync', 'existsSync', 'statSync', 'lstatSync']) {
  const original = fs[name];
  fs[name] = function (...args) { rejectObservedFile(args[0]); return original.apply(this, args); };
}
for (const name of ['readFile', 'open', 'stat', 'lstat']) {
  const original = fs.promises[name];
  fs.promises[name] = function (...args) { rejectObservedFile(args[0]); return original.apply(this, args); };
}
syncBuiltinESMExports();

const denyNetwork = () => { process.stderr.write('SYNTHETIC_NETWORK_BLOCKED\n'); throw new Error('synthetic network blocked'); };
net.Socket.prototype.connect = denyNetwork;
dns.lookup = denyNetwork;
dns.lookupService = denyNetwork;
for (const name of Object.keys(dns)) if (name.startsWith('resolve') || name === 'reverse') dns[name] = denyNetwork;

register('./raw-restore-pg-loader.mjs', import.meta.url);
