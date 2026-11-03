import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { checksumOf } from '../lib/migration-files';
import { PRESCRIPTION_ISSUANCE_MIGRATIONS } from '../lib/prescription-issuance-migration';
it('keeps issuance runtime and numbered SQL byte-identical without altering historical lineage', () => {
 const migration = PRESCRIPTION_ISSUANCE_MIGRATIONS[0];
 expect(migration.version).toBe('0093'); expect(readFileSync(`migrations/${migration.filename}`,'utf8')).toBe(migration.sql);
 expect(checksumOf(migration.sql)).toBe(migration.checksum);
 expect(checksumOf(readFileSync('migrations/0090_booking_request_preferences.sql','utf8'))).toBe('608eeee37b44a59cb4d26e915bd0b2610cf619103905be1fca0c2abe77c52e25');
 expect(checksumOf(readFileSync('migrations/0091_prescribing_doctor_identity.sql','utf8'))).toBe('d075fd6222bf8204c2e7de2ea536b66c8f8db71178eaa70de2294f0dba227044');
 expect(checksumOf(readFileSync('migrations/0092_prescribing_doctor_snapshot.sql','utf8'))).toBe('587529f146e1bf72fc654cff4fbacb0f233729efaadf26e44fdfde8e802af240');
});
