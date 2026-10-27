import { readLegacyStaffSchema, assertLegacyPermissionEnvelope } from "./legacy-staff-boundary";
import { sessionCredentialVersion, type SessionPayload } from './auth';
import { IdentityPreviewError } from './hr-identity-preview';
import type { IdentityAccount, IdentityContractLink, IdentityParty, IdentityPayrollLink, IdentityStaff, IdentityAccountLink, IdentityPartyLink } from './hr-identity-preview-shared';
import { readPersonIdentitySchema, type IdentityQuery } from './hr-person-identity-schema-state';

export async function authorizeIdentityAdmin(client: IdentityQuery, session: SessionPayload | null, lock = false) {
  if (!session?.credentialVersion || session.expiresAt <= Date.now()) throw new IdentityPreviewError(401, 'انتهت الجلسة. سجّل الدخول من جديد.');
  if(await readLegacyStaffSchema(client)!=="base")throw new IdentityPreviewError(401, "انتهت الجلسة. سجّل الدخول من جديد.");
  const { rows: [actor] } = await client.query<{ id: number; username: string; role: string; is_active: boolean; password_hash: string; permissions: unknown }>(
    `SELECT id,username,role,is_active,password_hash,permissions FROM users WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [session.userId]);
  if(actor)assertLegacyPermissionEnvelope(actor.permissions);
  if (!actor || !actor.is_active || actor.username !== session.username || actor.role !== session.role
    || session.expiresAt <= Date.now() || session.credentialVersion !== sessionCredentialVersion(actor.password_hash)) {
    throw new IdentityPreviewError(401, 'انتهت الجلسة. سجّل الدخول من جديد.');
  }
  if (actor.role !== 'admin') throw new IdentityPreviewError(403, 'مراجعة هوية الطاقم للمدير وحده.');
  return session;
}

/** Same bounded, explicit safe projection for the existing preview and internal identity plan. */
export async function readHrIdentitySources(client: IdentityQuery) {
  const schemaFingerprint = await readPersonIdentitySchema(client);
  const query = async <T extends import('pg').QueryResultRow>(sql: string): Promise<T[]> => {
    const { rows } = await client.query<T>(`${sql} LIMIT 1001`);
    if (rows.length > 1000) throw new IdentityPreviewError(503, 'حجم المصادر يتجاوز حد المعاينة؛ لا تُعرض نتيجة جزئية.');
    return rows;
  };
  const accounts = await query<IdentityAccount>('SELECT id,display_name AS label,role,is_active AS active,party_id AS "partyId" FROM users ORDER BY id');
  const staff = await query<IdentityStaff>(`SELECT id,full_name AS label,user_id AS "userId",work_status AS "workStatus",
    hire_date IS NOT NULL AS "hireDateRecorded",contract_kind AS "contractKind",
    (salary_amount_minor IS NOT NULL AND salary_currency IS NOT NULL AND salary_period IS NOT NULL AND salary_effective_on IS NOT NULL) AS "salaryTermsComplete"
    ${schemaFingerprint ? ',identity_revision AS "identityRevision"' : ''} FROM hr_staff ORDER BY id`);
  const contracts = await query<IdentityContractLink>('SELECT id,staff_id AS "staffId",doctor_party_id AS "partyId",status FROM hr_contracts ORDER BY id');
  const payrollLinks = await query<IdentityPayrollLink>(`SELECT DISTINCT i.staff_id AS "staffId",p.party_id AS "partyId"
    FROM hr_payroll_items i JOIN payables p ON p.id=i.payable_id OR p.id=i.commission_payable_id ORDER BY "staffId","partyId"`);
  const parties = await query<IdentityParty>(`SELECT p.id,CASE WHEN p.kind IN ('doctor','employee') THEN p.name ELSE NULL END AS label,p.kind,p.is_active AS active
    FROM parties p WHERE p.kind IN ('doctor','employee') OR EXISTS(SELECT 1 FROM users u WHERE u.party_id=p.id)
    OR EXISTS(SELECT 1 FROM hr_contracts c WHERE c.doctor_party_id=p.id)
    OR EXISTS(SELECT 1 FROM hr_payroll_items i JOIN payables b ON b.id=i.payable_id OR b.id=i.commission_payable_id WHERE b.party_id=p.id) ORDER BY p.id`);
  if (!schemaFingerprint) return { accounts, staff, contracts, payrollLinks, parties };
  const accountLinks = await query<IdentityAccountLink>(`SELECT id::text,staff_id AS "staffId",user_id AS "userId",closed_at IS NOT NULL AS closed,
    opened_event_id::text AS "openedEventId",closed_event_id::text AS "closedEventId" FROM hr_staff_account_links ORDER BY id`);
  const partyLinks = await query<IdentityPartyLink>(`SELECT id::text,staff_id AS "staffId",party_id AS "partyId",closed_at IS NOT NULL AS closed,
    opened_event_id::text AS "openedEventId",closed_event_id::text AS "closedEventId" FROM hr_staff_party_links ORDER BY id`);
  return { accounts, staff, contracts, payrollLinks, parties, schemaFingerprint, accountLinks, partyLinks };
}
