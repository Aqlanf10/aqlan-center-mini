import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/session', () => ({ requireSession: vi.fn() }));
vi.mock('@/lib/patient-access', () => ({ canAccessPatient: vi.fn() }));
vi.mock('@/lib/ortho-plan-link-access', () => ({ canChangeOrthoPlanLink: vi.fn() }));
vi.mock('@/lib/db', () => ({ CLINIC_TIME_ZONE: 'Asia/Aden', recordOrthoBaseline: vi.fn() }));
import { POST } from '@/app/api/ortho/baseline/route';
import { requireSession } from '@/lib/session';
import { canAccessPatient } from '@/lib/patient-access';
import { canChangeOrthoPlanLink } from '@/lib/ortho-plan-link-access';
import { recordOrthoBaseline } from '@/lib/db';
import { OrthoBaselineAuthorityError } from '@/lib/ortho-baseline-authority';
import { checkBaselineDraft } from '@/lib/ortho-baseline';
import { clinicDateString } from '@/lib/schedule';
const session = { userId: 7, username: 'synthetic-doctor', role: 'doctor', partyId: 23, expiresAt: 4_102_444_800_000 };
const body = { patientId: 101, phase: 'working', financialMode: 'opening_balance', monthsElapsed: 10, monthsRemaining: 8 };
const request = (payload: unknown = body) => new Request('https://synthetic.invalid/api/ortho/baseline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
beforeEach(() => {
 vi.resetAllMocks();
 vi.mocked(requireSession).mockResolvedValue(session as never);
 vi.mocked(canAccessPatient).mockResolvedValue(true);
 vi.mocked(canChangeOrthoPlanLink).mockResolvedValue(true);
 vi.mocked(recordOrthoBaseline).mockResolvedValue({ ok: true, id: 55 });
});
// Real HTTP handler/parser; mocked writer. These assertions do not prove locks,
// transactional authority, persistence or absence of financial side effects.
describe('baseline trusted request boundary', () => {
 it('uses admitted patient/session and ignores forged actor or transaction context', async () => {
  const payload = { ...body, actor: 'forged', actorRole: 'admin', session: { userId: 999 }, request: { patientId: 999, session: { userId: 999 } } };
  const parsed = checkBaselineDraft(payload, clinicDateString(new Date(), 'Asia/Aden'));
  expect(parsed.ok).toBe(true); if (!parsed.ok) throw Error('fixture');
  const response = await POST(request(payload));
  expect(response.status).toBe(201); expect(await response.json()).toEqual({ id: 55 });
  expect(recordOrthoBaseline).toHaveBeenCalledExactlyOnceWith({ ...parsed.value, responsibleDoctorId: 23, patientId: 101, actor: session.username, actorRole: session.role }, { patientId: 101, session });
 });
 it('retains explicit responsible doctor and authorized plan link', async () => {
  const response = await POST(request({ ...body, responsibleDoctorId: 31, planId: 41 }));
  expect(response.status).toBe(201);
  expect(canChangeOrthoPlanLink).toHaveBeenCalledExactlyOnceWith(session, 101);
  expect(vi.mocked(recordOrthoBaseline).mock.calls[0][0]).toMatchObject({ responsibleDoctorId: 31, planId: 41 });
 });
 it('refuses a denied plan link before the writer', async () => {
  vi.mocked(canChangeOrthoPlanLink).mockResolvedValue(false);
  expect((await POST(request({ ...body, planId: 41 }))).status).toBe(403);
  expect(recordOrthoBaseline).not.toHaveBeenCalled();
 });
 it.each([{ phase: '' }, { financialMode: 'invalid' }, { monthsRemaining: -1 }])('retains clinical/recorded financial-mode admission %j', async invalid => {
  expect((await POST(request({ ...body, ...invalid }))).status).toBe(400);
  expect(recordOrthoBaseline).not.toHaveBeenCalled();
 });
 it.each(['reception', 'assistant', 'cashier', 'accountant'])('refuses role %s before the writer', async role => {
  vi.mocked(requireSession).mockResolvedValue({ ...session, role } as never);
  expect((await POST(request())).status).toBe(403);
  expect(recordOrthoBaseline).not.toHaveBeenCalled();
 });
 it('retains expired-session and denied-patient guards', async () => {
  vi.mocked(requireSession).mockResolvedValue(null);
  expect((await POST(request())).status).toBe(401);
  vi.mocked(requireSession).mockResolvedValue(session as never);
  vi.mocked(canAccessPatient).mockResolvedValue(false);
  expect((await POST(request())).status).toBe(403);
  expect(recordOrthoBaseline).not.toHaveBeenCalled();
 });
 it.each([['no_patient',404],['open_case',409],['bad_doctor',400],['bad_plan',400],['bridge_conflict',409]] as const)('preserves writer refusal %s', async (reason,status) => {
  vi.mocked(recordOrthoBaseline).mockResolvedValue({ ok:false, reason });
  expect((await POST(request())).status).toBe(status);
 });
 it.each([400, 401, 403, 409] as const)('maps typed transaction authority status %s with its public refusal code', async status => {
  vi.mocked(recordOrthoBaseline).mockRejectedValue(new OrthoBaselineAuthorityError(status, 'baseline_scope_changed', 'تعذر اعتماد الطلب في نطاقه الحالي.'));
  const response = await POST(request());
  expect(response.status).toBe(status);
  const payload = await response.json();
  expect(payload).toEqual({ message: 'تعذر اعتماد الطلب في نطاقه الحالي.', code: 'baseline_scope_changed' });
  expect(JSON.stringify(payload)).not.toContain('stack');
  expect(recordOrthoBaseline).toHaveBeenCalledTimes(1);
 });
 it('does not expose unexpected writer failures', async () => {
  vi.mocked(recordOrthoBaseline).mockRejectedValue(new Error('private synthetic error'));
  const response = await POST(request());
  expect(response.status).toBe(500); expect(await response.text()).not.toContain('private synthetic error');
 });
});
