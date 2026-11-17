import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const expected = Object.freeze({
  hr_restore: 'restores the actual pre-HR archive on the current migration chain without inventing employee history',
  hr_truncated: 'refuses a truncated archive before creating any target table',
  hr_rollback: 'rolls back every restored data row on a late SQL failure, keeping append-only triggers and migration records intact',
  inventory_legacy: 'pre-identity backup restores with new subjects and explicit managed initialization, without inventing command provenance',
  inventory_hold: 'identity-dependent history without source identity rolls back the whole restored dataset',
});
const allowed = new Set(['passed', 'failed', 'pending', 'skipped', 'todo']);
const expectedSuites = Object.freeze({
  hr_restore: '__tests__/postgres/hr-composed-legacy-restore.test.ts',
  hr_truncated: '__tests__/postgres/hr-composed-legacy-restore.test.ts',
  hr_rollback: '__tests__/postgres/hr-composed-legacy-restore.test.ts',
  inventory_legacy: '__tests__/postgres/inventory-authority-maintenance.test.ts',
  inventory_hold: '__tests__/postgres/inventory-authority-maintenance.test.ts',
});
function summarize(raw, outcome) {
  const statuses = Object.fromEntries(Object.keys(expected).map(key => [key, 'not_reported']));
  let valid = true;
  if (raw !== null) {
    if (!raw || !Array.isArray(raw.testResults)) valid = false;
    else {
      const seen = new Set();
      for (const suite of raw.testResults) {
        if (!suite || !Array.isArray(suite.assertionResults)) { valid = false; continue; }
        for (const item of suite.assertionResults) {
          const key = Object.keys(expected).find(name => expected[name] === item?.title);
          // The selector intentionally excludes other tests; Vitest may list them as pending.
          if (!key) continue;
          const name = typeof suite.name === 'string' ? suite.name.replaceAll('\\', '/') : '';
          if (!(name === expectedSuites[key] || name.endsWith('/' + expectedSuites[key]))
              || seen.has(key) || !allowed.has(item.status)) { valid = false; continue; }
          seen.add(key);
          statuses[key] = item.status;
        }
      }
    }
  }
  if (!valid) for (const key of Object.keys(statuses)) statuses[key] = 'unclassified';
  return { report_version: 1, witness_step: ['success', 'failure', 'cancelled'].includes(outcome) ? outcome : 'unclassified', cases: statuses };
}

function reportPassed(report) {
  if (!report || typeof report !== 'object' || report.report_version !== 1 || report.witness_step !== 'success') return false;
  if (Object.keys(report).sort().join(',') !== 'cases,report_version,witness_step') return false;
  if (!report.cases || typeof report.cases !== 'object') return false;
  const keys = Object.keys(expected);
  if (Object.keys(report.cases).sort().join(',') !== keys.slice().sort().join(',')) return false;
  return keys.every(key => report.cases[key] === 'passed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = process.env.RUNNER_TEMP;
    if (!root || !path.isAbsolute(root)) throw new Error('Invalid synthetic report location');
    const output = path.join(root, 'restore-history-safe-report.json');
    if (process.argv[2] === '--gate') {
      if (!reportPassed(JSON.parse(fs.readFileSync(output, 'utf8')))) throw new Error('Synthetic witness incomplete');
      process.stdout.write('SYNTHETIC_HISTORY_WITNESS_COMPLETE\n');
    } else {
      const input = path.join(root, 'restore-history-vitest.json');
      let raw = null;
      if (fs.existsSync(input)) raw = JSON.parse(fs.readFileSync(input, 'utf8'));
      const report = summarize(raw, process.env.SYNTHETIC_WITNESS_OUTCOME);
      fs.writeFileSync(output, JSON.stringify(report) + '\n', { flag: 'wx', mode: 0o600 });
    }
  } catch {
    process.stderr.write('SYNTHETIC_HISTORY_REPORT_CAPTURE_FAILED\n');
    process.exitCode = 1;
  }
}
export { summarize, reportPassed, expected, expectedSuites };
