import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Keep the standalone CI sanitizer contract executable under Vitest too.
// The imported check preserves every offline redaction and manifest assertion.
it('keeps diagnostic output bounded, redacted, and complete for the reviewed browser cases', async () => {
  await import('./summarize-check.mjs');
});

it('keeps the diagnostic workflow on the dependency-free standalone check', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ceph-canvas-diagnostic.yml', import.meta.url), 'utf8');
  expect(workflow).toContain('run: node scripts/ceph-diagnostic/summarize-check.mjs');
  expect(workflow).not.toContain('run: node scripts/ceph-diagnostic/summarize.test.mjs');
});
