import { IdentityPreviewError } from './hr-identity-preview';
import { readPersonIdentitySchema, type IdentityQuery } from './hr-person-identity-schema-state';

/** Descriptive identity only. Never substitute this for staffIdForUser/access guards. */
export async function staffIdentityForUser(client: IdentityQuery, userId: number): Promise<number | null> {
  const installed = await readPersonIdentitySchema(client);
  const { rows } = await client.query<{ id: number }>(installed ? `SELECT s.id FROM hr_staff s WHERE
    (s.identity_revision=0 AND s.user_id=$1) OR (s.identity_revision>0 AND EXISTS(
      SELECT 1 FROM hr_staff_account_links l WHERE l.staff_id=s.id AND l.user_id=$1 AND l.closed_at IS NULL)) ORDER BY s.id`
    : 'SELECT id FROM hr_staff WHERE user_id=$1 ORDER BY id',[userId]);
  if (rows.length > 1) throw new IdentityPreviewError(409,'هوية الحساب متعارضة؛ تحتاج مراجعة.');
  return rows[0]?.id ?? null;
}

async function historicalPeople(client: IdentityQuery, userId: number): Promise<number[]> {
  const { rows } = await client.query<{ id: number }>(`SELECT id FROM hr_staff WHERE user_id=$1
    UNION SELECT staff_id AS id FROM hr_staff_account_links WHERE user_id=$1 ORDER BY id`,[userId]);
  return rows.map(r => r.id);
}
export interface RequestIdentityEvidence {
  version: 1; subjectStaffId: number; subjectRevision: number; requesterUserId: number;
  requesterStaffIds: number[]; accountLinkIds: string[]; eventIds: string[];
}
/** Caller holds the shared identity lock and the existing request/subject locks. */
export async function captureRequestIdentity(client: IdentityQuery, staffId: number, requesterUserId: number): Promise<RequestIdentityEvidence | null> {
  if (!(await readPersonIdentitySchema(client))) return null;
  const { rows: [staff] } = await client.query<{ identity_revision: number }>('SELECT identity_revision FROM hr_staff WHERE id=$1',[staffId]);
  if (!staff) throw new IdentityPreviewError(409,'ملف الشخص غير موجود.');
  const requesterStaffIds = await historicalPeople(client,requesterUserId);
  if (requesterStaffIds.length > 1) throw new IdentityPreviewError(409,'هوية مقدم الطلب تحتاج مراجعة.');
  const { rows: links } = await client.query<{ id: string; event_id: string }>(`SELECT id::text,opened_event_id::text AS event_id
    FROM hr_staff_account_links WHERE staff_id=$1 OR user_id=$2 ORDER BY id`,[staffId,requesterUserId]);
  return {version:1,subjectStaffId:staffId,subjectRevision:staff.identity_revision,requesterUserId,requesterStaffIds,
    accountLinkIds:links.map(l => l.id),eventIds:[...new Set(links.map(l => l.event_id))]};
}

/** Identity can narrow approval; it grants no operation or row access. Historical
 * evidence remains relevant after unlinking; ambiguous old requests fail closed. */
export async function assertPersonMayApprove(client: IdentityQuery, input: {
  actorUserId: number; subjectStaffId: number; requesterUserId?: number | null;
  evidence?: RequestIdentityEvidence | null; hasRequest: boolean;
}): Promise<void> {
  if (!(await readPersonIdentitySchema(client))) return;
  const actorPeople = await historicalPeople(client,input.actorUserId);
  if (actorPeople.length > 1) throw new IdentityPreviewError(409,'هوية المعتمد متعارضة؛ تحتاج مراجعة.');
  if (actorPeople.includes(input.subjectStaffId) || input.requesterUserId === input.actorUserId) {
    throw new IdentityPreviewError(403,'لا يجوز اعتماد طلب الشخص نفسه عبر أي من حساباته.');
  }
  if (!input.hasRequest) return;
  const { rows: [subject] } = await client.query<{ identity_revision: number }>('SELECT identity_revision FROM hr_staff WHERE id=$1',[input.subjectStaffId]);
  if (input.requesterUserId == null || !input.evidence) {
    if (actorPeople.length || (subject?.identity_revision ?? 0) > 0) {
      throw new IdentityPreviewError(409,'هوية مقدم الطلب القديم غير موثقة؛ تلزم مراجعة مستقلة قبل الاعتماد.');
    }
    return;
  }
  const evidence = input.evidence;
  if (evidence.version !== 1 || evidence.subjectStaffId !== input.subjectStaffId || evidence.requesterUserId !== input.requesterUserId
    || !Array.isArray(evidence.requesterStaffIds) || evidence.requesterStaffIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw new IdentityPreviewError(409,'دليل هوية الطلب غير مكتمل؛ تلزم مراجعة.');
  }
  const requesterPeople = [...new Set([...evidence.requesterStaffIds,...await historicalPeople(client,input.requesterUserId)])];
  if (requesterPeople.length > 1) throw new IdentityPreviewError(409,'هوية مقدم الطلب متعارضة؛ تحتاج مراجعة.');
  if (requesterPeople.some(id => actorPeople.includes(id))) {
    throw new IdentityPreviewError(403,'لا يجوز لمقدم الطلب اعتماده بحساب آخر للشخص نفسه.');
  }
}

/** Unknown identity does not establish an employment relationship or entitlement. */
export async function assertDocumentedStaffForOperation(client: IdentityQuery, staffId: number) {
  const { rows: [staff] } = await client.query<{ work_status: string; contract_kind: string }>(
    'SELECT work_status,contract_kind FROM hr_staff WHERE id=$1',[staffId]);
  if (staff && (staff.work_status === 'unconfirmed' || staff.contract_kind === 'unspecified')) {
    throw new IdentityPreviewError(409,'هوية الشخص لا تثبت شروط عمل؛ وثّق الحالة والعقد قبل الدوام أو الإجازة أو الاستحقاق.');
  }
}
