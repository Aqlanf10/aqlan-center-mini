import { lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const linePattern = /^::notice::FINANCE_CI_DIAG (?:COUNT actual=(?:[0-9]|10|other) expected=(?:[0-9]|10|other)|RETRY status=(?:200|201|400|401|403|404|409|422|429|500|502|503|504|other)|RELOAD kind=(?:timeout|other))$/;

// Validate the entire file before emitting any line, so unexpected input never
// reaches a workflow command or the job log. The test report remains untouched.
export function validatedNotices(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 16384) return null;
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.pop() !== '' || lines.length > 100 || lines.some(line => !linePattern.test(line))) return null;
  return lines;
}

export function readNotices(filename) {
  try {
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.size > 16384) return null;
    return validatedNotices(readFileSync(filename, 'utf8'));
  } catch (error) {
    return error && typeof error === 'object' && error.code === 'ENOENT' ? [] : null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lines = process.argv[2] ? readNotices(process.argv[2]) : null;
  if (lines === null) console.log('::notice::FINANCE_CI_DIAG unavailable');
  else if (!lines.length) console.log('::notice::FINANCE_CI_DIAG no-records');
  else for (const line of lines) console.log(line);
}
