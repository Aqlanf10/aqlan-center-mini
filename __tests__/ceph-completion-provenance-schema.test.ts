import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CEPH_COMPLETION_PROVENANCE_SQL } from '../lib/ceph-completion-provenance-schema';
import { CEPH_PROVENANCE_HISTORY_TABLES, RESET_KEEP_TABLES, RESET_WIPE_TABLES } from '../lib/clinic-reset';

it('ships an exact additive mirror without fabricating historical witnesses', () => {
  expect(CEPH_COMPLETION_PROVENANCE_SQL).toBe(readFileSync('migrations/0113_ceph_completion_provenance.sql', 'utf8'));
  expect(CEPH_COMPLETION_PROVENANCE_SQL).not.toMatch(/\b(?:ALTER TABLE|DROP TABLE|INSERT INTO|UPDATE ceph_analyses)\b/);
  expect(CEPH_COMPLETION_PROVENANCE_SQL).toContain('actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT');
});
it('retains provenance during reset and guards immutable evidence', () => {
  expect(CEPH_PROVENANCE_HISTORY_TABLES).toEqual(['ceph_completion_provenance']);
  expect(RESET_KEEP_TABLES).toContain('ceph_completion_provenance');
  expect(RESET_WIPE_TABLES).not.toContain('ceph_completion_provenance');
  expect(CEPH_COMPLETION_PROVENANCE_SQL).toContain('BEFORE TRUNCATE ON ceph_completion_provenance');
  expect(CEPH_COMPLETION_PROVENANCE_SQL).toContain('DEFERRABLE INITIALLY DEFERRED');
});
