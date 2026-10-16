import { readFileSync } from 'node:fs';
import { sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { reviewHrPersonIdentity, applyHrPersonIdentityPlan } from '../../lib/hr-person-identity';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';

/** Each caller owns its synthetic database; no shared financial fixtures. */
export async function openPersonIdentityReviewFixture() {
  const owned = await openBackupTimestampFixture({ ...process.env });
  const keys = ['DATABASE_URL', 'SKIP_SEED', 'DB_POOL_MAX', 'SESSION_SECRET'] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.DATABASE_URL = owned.source.options.connectionString!;
  process.env.SKIP_SEED = 'false'; process.env.DB_POOL_MAX = '4';
  process.env.SESSION_SECRET = 'synthetic-person-review-secret-0123456789';
  const db = await import('../../lib/db');
  let serial = 0;
  const close = async () => {
    try { await db.resetPoolForTesting(); await owned.close(); }
    finally { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
  };
  try {
    await db.resetPoolForTesting(); await db.ensureSchema();
    await owned.source.query(readFileSync(new URL('../../docs/proposals/hr-person-identity.sql', import.meta.url), 'utf8'));
    const account = async (role: SessionPayload['role'] = 'admin') => {
      const username = `identity-review-${++serial}`;
      const { rows: [row] } = await owned.source.query(`INSERT INTO users(username,display_name,password_hash,role)
        VALUES($1,'Synthetic review account','synthetic-review-hash',$2) RETURNING id`, [username, role]);
      return { userId: row.id, username, role, credentialVersion: sessionCredentialVersion('synthetic-review-hash'), expiresAt: Date.now() + 3600_000 } satisfies SessionPayload;
    };
    const reviewer = await account();
    const staff = async (userId: number | null = null) => (await owned.source.query(`INSERT INTO hr_staff(full_name,user_id,created_by,work_status,contract_kind,hire_date)
      VALUES('Synthetic review person',$1,'synthetic','active','commission','2026-01-01') RETURNING id`, [userId])).rows[0].id as number;
    const convert = async (staffId: number, userIds: number[], partyId: number | null = null) => {
      const plan = await reviewHrPersonIdentity(db.getPool(), reviewer, [{ key: 'person', staffId, expectedRevision: 0, fullName: null,
        userIds, partyId, confirmedSamePerson: true, reason: 'Synthetic independently reviewed identity', sourceRef: 'synthetic-review-proof',
        closeAccountLinkIds: [], closePartyLinkId: null }]);
      return applyHrPersonIdentityPlan(db.getPool(), reviewer, { requestId: `review-request-${++serial}`, plan });
    };
    return { ...owned, db, reviewer, account, staff, convert, close };
  } catch (error) { await close(); throw error; }
}
