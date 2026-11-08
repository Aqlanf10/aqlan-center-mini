import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CEPH_COMPLETION_SOURCE_CAS_SQL } from '../lib/ceph-completion-source-cas-schema';

it('expands only the version envelope through an exact new migration', () => {
  expect(CEPH_COMPLETION_SOURCE_CAS_SQL).toBe(readFileSync('migrations/0114_ceph_completion_source_cas.sql','utf8'));
  expect(CEPH_COMPLETION_SOURCE_CAS_SQL).toContain('CHECK(schema_version IN (1,2))');
  expect(CEPH_COMPLETION_SOURCE_CAS_SQL).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE TRIGGER|DROP TRIGGER)\b/);
  expect(CEPH_COMPLETION_SOURCE_CAS_SQL.match(/ALTER TABLE/g)).toHaveLength(1);
});
it('does not amend the frozen 0113 migration', () => {
  expect(createHash('sha256').update(readFileSync('migrations/0113_ceph_completion_provenance.sql')).digest('hex')).toBe('9f2939bffc4df0d1d63bfb41be920f6b8621ab75f208b760d6d005175bf3a0e6');
});
