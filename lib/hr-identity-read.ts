import type { DbPool } from './db';
import { sessionCredentialVersion, type SessionPayload } from './auth';
import { buildIdentityPreview, IdentityPreviewError, parseIdentityPreviewRequest } from './hr-identity-preview';
import type { IdentityAccount, IdentityContractLink, IdentityParty, IdentityPayrollLink, IdentityStaff } from './hr-identity-preview-shared';

const LIMIT = 1000;
/** The caller supplies a verified signed session, never a session from request JSON.
 * Authentication and evidence use the same READ ONLY snapshot. No schema/bootstrap,
 * audit writer, commission resolver, row lock or sequence allocation is invoked. */
export async function readHrIdentityPreview(pool: Pick<DbPool, 'connect'>, session: SessionPayload | null, request?: unknown) {
  if (!session?.credentialVersion || session.expiresAt <= Date.now()) throw new IdentityPreviewError(401, 'انتهت الجلسة. سجّل الدخول من جديد.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: [actor] } = await client.query<{ id: number; username: string; role: string; is_active: boolean; password_hash: string }>(
      'SELECT id,username,role,is_active,password_hash FROM users WHERE id=$1', [session.userId]);
    if (!actor || !actor.is_active || actor.username !== session.username || actor.role !== session.role
      || session.expiresAt <= Date.now() || session.credentialVersion !== sessionCredentialVersion(actor.password_hash)) {
      throw new IdentityPreviewError(401, 'انتهت الجلسة. سجّل الدخول من جديد.');
    }
    if (actor.role !== 'admin') throw new IdentityPreviewError(403, 'معاينة هوية الطاقم للمدير وحده.');
    const query = async <T extends import('pg').QueryResultRow>(sql: string): Promise<T[]> => {
      const { rows } = await client.query<T>(`${sql} LIMIT ${LIMIT + 1}`);
      if (rows.length > LIMIT) throw new IdentityPreviewError(503, 'حجم المصادر يتجاوز حد المعاينة؛ لا تُعرض نتيجة جزئية.');
      return rows;
    };
    const accounts = await query<IdentityAccount>('SELECT id,display_name AS label,role,is_active AS active,party_id AS "partyId" FROM users ORDER BY id');
    const staff = await query<IdentityStaff>(`SELECT id,full_name AS label,user_id AS "userId",work_status AS "workStatus",
      hire_date IS NOT NULL AS "hireDateRecorded",contract_kind AS "contractKind",
      (salary_amount_minor IS NOT NULL AND salary_currency IS NOT NULL AND salary_period IS NOT NULL AND salary_effective_on IS NOT NULL) AS "salaryTermsComplete"
      FROM hr_staff ORDER BY id`);
    const contracts = await query<IdentityContractLink>('SELECT id,staff_id AS "staffId",doctor_party_id AS "partyId",status FROM hr_contracts ORDER BY id');
    const payrollLinks = await query<IdentityPayrollLink>(`SELECT DISTINCT i.staff_id AS "staffId",p.party_id AS "partyId"
      FROM hr_payroll_items i JOIN payables p ON p.id=i.payable_id OR p.id=i.commission_payable_id ORDER BY "staffId","partyId"`);
    const parties = await query<IdentityParty>(`SELECT p.id,CASE WHEN p.kind IN ('doctor','employee') THEN p.name ELSE NULL END AS label,p.kind,p.is_active AS active
      FROM parties p WHERE p.kind IN ('doctor','employee') OR EXISTS(SELECT 1 FROM users u WHERE u.party_id=p.id)
      OR EXISTS(SELECT 1 FROM hr_contracts c WHERE c.doctor_party_id=p.id)
      OR EXISTS(SELECT 1 FROM hr_payroll_items i JOIN payables b ON b.id=i.payable_id OR b.id=i.commission_payable_id WHERE b.party_id=p.id) ORDER BY p.id`);
    const sources = { accounts, staff, contracts, payrollLinks, parties };
    let preview = buildIdentityPreview(sources);
    if (request !== undefined) {
      const parsed = parseIdentityPreviewRequest(request);
      if (parsed.sourceDigest !== preview.sourceDigest) throw new IdentityPreviewError(409, 'تغيّرت المصادر؛ حدّث المعاينة وراجع المعرفات مجددًا.');
      preview = buildIdentityPreview(sources, parsed.decisions);
    }
    if (session.expiresAt <= Date.now()) throw new IdentityPreviewError(401, 'انتهت الجلسة. سجّل الدخول من جديد.');
    await client.query('COMMIT');
    return preview;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
