import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ensure = (x, msg) => { if (!x) throw new Error(msg); };
export async function checkWrapperChunks(standaloneRoot, inventory) {
  let entries = 0, references = 0;
  const prefix = '.next/server/';
  for (const [file, expectedHash] of Object.entries(inventory)) {
    if (!file.startsWith(prefix) || !file.endsWith('.js')) continue;
    const text = await readFile(path.join(standaloneRoot, file), 'utf8');
    ensure(digest(text) === expectedHash, `changed entry ${file}`);
    const lines = text.split('\n');
    const isWrapper = lines[0].startsWith('var R=require(') && lines[0].includes('[turbopack]_runtime.js');
    const rCalls = text.match(/\bR\.c\s*\(/g) ?? [];
    if (!isWrapper && rCalls.length === 0) continue;
    ensure(isWrapper, `unknown runtime chunk syntax ${file}`);
    const calls = lines.filter(line => /^R\.c\s*\(/.test(line));
    ensure(calls.length === rCalls.length && calls.length > 0, `unknown chunk call ${file}`);
    entries++;
    for (const call of calls) {
      const match = /^R\.c\("(server\/chunks\/[a-zA-Z0-9_@.\/[\]~-]+\.js)"\)\r?$/.exec(call);
      ensure(match && !match[1].split('/').includes('..') && !match[1].split('/').includes('.'), `unknown chunk reference ${file}`);
      const target = `.next/${match[1]}`;
      ensure(Object.hasOwn(inventory, target), `missing inventoried chunk ${target}`);
      const bytes = await readFile(path.join(standaloneRoot, target));
      ensure(digest(bytes) === inventory[target], `changed chunk ${target}`);
      references++;
    }
  }
  ensure(entries > 0 && references > 0, 'empty wrapper chunk inventory');
  return {entries, references};
}
