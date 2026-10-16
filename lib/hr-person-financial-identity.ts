import { IdentityPreviewError } from './hr-identity-preview';
import { readPersonIdentitySchema, type IdentityQuery } from './hr-person-identity-schema-state';

/** For the existing payroll writer only. A missing explicit link is not permission
 * to create a party, choose a legacy account, or change a commission policy. */
export async function explicitStaffFinancialParty(client: IdentityQuery, staffId: number, identityRevision: number) {
  if (identityRevision === 0) return null;
  if (!(await readPersonIdentitySchema(client))) throw new IdentityPreviewError(503,'مخطط هوية الشخص غير مكتمل.');
  const { rows } = await client.query<{ id: number; kind: string; is_active: boolean }>(`SELECT p.id,p.kind,p.is_active FROM hr_staff_party_links l
    JOIN parties p ON p.id=l.party_id WHERE l.staff_id=$1 AND l.closed_at IS NULL`,[staffId]);
  if (rows.length !== 1 || !rows[0].is_active || !['doctor','employee'].includes(rows[0].kind)) {
    throw new IdentityPreviewError(409,'الجهة المالية الصريحة للشخص غير محسومة أو غير نشطة؛ راجع الربط قبل المسير.');
  }
  const { rows: witnesses } = await client.query<{ party_id: number }>(`SELECT party_id FROM users WHERE party_id IS NOT NULL AND
    (id IN (SELECT user_id FROM hr_staff_account_links WHERE staff_id=$1 AND closed_at IS NULL)
      OR id IN (SELECT user_id FROM hr_staff WHERE id=$1))
    UNION SELECT doctor_party_id FROM hr_contracts WHERE staff_id=$1 AND status IN ('active','approved') AND doctor_party_id IS NOT NULL
    UNION SELECT p.party_id FROM hr_payroll_items i JOIN payables p ON p.id=i.payable_id OR p.id=i.commission_payable_id WHERE i.staff_id=$1`,[staffId]);
  if (witnesses.some(w => w.party_id !== rows[0].id)) throw new IdentityPreviewError(409,'تعارض جهة الشخص مع الحساب أو العقد أو المسير السابق؛ لا اختيار تلقائي.');
  return {partyId:rows[0].id,kind:rows[0].kind};
}
