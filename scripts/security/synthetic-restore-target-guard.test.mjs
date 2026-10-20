import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeLegacyRestoreTarget } from './synthetic-restore-target-guard.mjs';
const fixture = 'postgresql://fixture:fixture@127.0.0.1:5432/backup_dst_synthetic007';
test('accept isolated synthetic local target only', () => {
  assert.equal(assertSafeLegacyRestoreTarget(fixture, { DATABASE_ENVIRONMENT:'test' }).database, 'backup_dst_synthetic007');
});
for (const [name,url,env] of [
  ['production declaration', fixture, { DATABASE_ENVIRONMENT:'production' }],
  ['Railway runtime', fixture, { RAILWAY_PROJECT_ID:'fixture' }],
  ['remote database', 'postgresql://fixture:fixture@db.internal:5432/backup_dst_synthetic007', { DATABASE_ENVIRONMENT:'test' }],
  ['non-isolated local database', 'postgresql://fixture:fixture@127.0.0.1:5432/live_clinic', { DATABASE_ENVIRONMENT:'test' }],
  ['malformed target', 'not-a-url', { DATABASE_ENVIRONMENT:'test' }],
  ['staging declaration', fixture, { DATABASE_ENVIRONMENT:'staging' }],
]) test('reject ' + name, () => assert.throws(() => assertSafeLegacyRestoreTarget(url,env), /Legacy restore refused/));
