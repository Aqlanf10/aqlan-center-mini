import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/session', () => ({ requireSession: vi.fn() }));
vi.mock('@/lib/patient-access', () => ({ canAccessPatient: vi.fn() }));
vi.mock('@/lib/ortho-plan-link-access', () => ({ canChangeOrthoPlanLink: vi.fn() }));
vi.mock('@/lib/db', () => ({ CLINIC_TIME_ZONE: 'Asia/Aden', createOrthoCase: vi.fn(), recordAudit: vi.fn() }));
import { POST } from '@/app/api/ortho/route';
import { requireSession } from '@/lib/session';
import { canAccessPatient } from '@/lib/patient-access';
import { canChangeOrthoPlanLink } from '@/lib/ortho-plan-link-access';
import { createOrthoCase, recordAudit } from '@/lib/db';
import { OrthoCreateAuthorityError } from '@/lib/ortho-create-authority';
const session = { userId: 7, username: 'synthetic-doctor', role: 'doctor', partyId: 23, expiresAt: 4_102_444_800_000 };
const body = { patientId: 101, startDate: '2026-11-07' };
const request = (payload: unknown = body) => new Request('https://synthetic.invalid/api/ortho', {
 method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});
beforeEach(() => {
 vi.resetAllMocks();
 vi.mocked(requireSession).mockResolvedValue(session as never);
 vi.mocked(canAccessPatient).mockResolvedValue(true);
 vi.mocked(canChangeOrthoPlanLink).mockResolvedValue(true);
 vi.mocked(createOrthoCase).mockResolvedValue({ ok: true, id: 55 });
});
// Real HTTP parser/handler with a mocked writer. These tests establish admitted
// context and response behavior, not PostgreSQL locks or atomic persistence.
describe('ordinary ortho creation trusted request boundary', () => {
 it('uses server session and ignores forged actor, patient scope and authority context', async () => {
  const payload = { ...body, createdBy: 'forged', actor: 'forged', actorRole: 'admin',
   session: { userId: 999, role: 'admin' }, request: { patientId: 999, session: { userId: 999 } },
   authority: { patientId: 999, session: { userId: 999 } } };
  const response = await POST(request(payload));
  expect(response.status).toBe(201); expect(await response.json()).toEqual({ id: 55 });
  expect(createOrthoCase).toHaveBeenCalledExactlyOnceWith({
   patientId: 101, appliance: 'fixed_metal', arches: 'both', slot: '022', bracketSystem: null,
   startDate: '2026-11-07', plannedMonths: 18, planId: null, note: null, createdBy: session.username,
  }, { patientId: 101, session });
 });
 it('leaves creation audit to the transaction writer instead of issuing a second best-effort audit', async () => {
  expect((await POST(request())).status).toBe(201);
  expect(recordAudit).not.toHaveBeenCalled();
 });
 it.each(['admin', 'reception', 'doctor'])('preserves effective CLINIC permission for %s', async role => {
  const admitted = { ...session, role };
  vi.mocked(requireSession).mockResolvedValue(admitted as never);
  expect((await POST(request({ ...body, planId: 41 }))).status).toBe(201);
  expect(canChangeOrthoPlanLink).toHaveBeenCalledExactlyOnceWith(admitted, 101);
  expect(createOrthoCase).toHaveBeenCalledTimes(1);
 });
 it.each(['assistant', 'cashier', 'accountant'])('refuses direct-handler role %s even if patient access is allowed', async role => {
  vi.mocked(requireSession).mockResolvedValue({ ...session, role } as never);
  expect((await POST(request())).status).toBe(403);
  expect(createOrthoCase).not.toHaveBeenCalled(); expect(recordAudit).not.toHaveBeenCalled();
 });
 it('retains unauthenticated and denied-patient guards', async () => {
  vi.mocked(requireSession).mockResolvedValue(null);
  expect((await POST(request())).status).toBe(401);
  vi.mocked(requireSession).mockResolvedValue(session as never);
  vi.mocked(canAccessPatient).mockResolvedValue(false);
  expect((await POST(request())).status).toBe(403);
  expect(createOrthoCase).not.toHaveBeenCalled();
 });
 it('retains rejected plan linkage before writing', async () => {
  vi.mocked(canChangeOrthoPlanLink).mockResolvedValue(false);
  expect((await POST(request({ ...body, planId: 41 }))).status).toBe(403);
  expect(createOrthoCase).not.toHaveBeenCalled();
 });
 it('does not require plan permission for an unlinked clinical case', async () => {
  vi.mocked(canChangeOrthoPlanLink).mockResolvedValue(false);
  expect((await POST(request())).status).toBe(201);
  expect(canChangeOrthoPlanLink).not.toHaveBeenCalled();
 });
 it.each([{ patientId: 0 }, { plannedMonths: 121 }, { plannedMonths: 0 }])('preserves invalid input refusal %j', async invalid => {
  expect((await POST(request({ ...body, ...invalid }))).status).toBe(400);
  expect(createOrthoCase).not.toHaveBeenCalled();
 });
 it('preserves defaults, integer numeric strings and valid boundary text', async () => {
  expect((await POST(request({ ...body, patientId: '101',
   plannedMonths: '18.0', planId: '41', bracketSystem: 'b'.repeat(80), note: 'n'.repeat(300) }))).status).toBe(201);
  expect(vi.mocked(createOrthoCase).mock.calls[0][0]).toEqual({ patientId: 101, appliance: 'fixed_metal', arches: 'both',
   slot: '022', startDate: '2026-11-07', plannedMonths: 18, planId: 41, bracketSystem: 'b'.repeat(80),
   note: 'n'.repeat(300), createdBy: session.username });
 });
 it.each(['appliance', 'arches', 'slot'])('rejects explicitly malformed %s before the writer', async field => {
  for (const value of ['unknown', ' aligners', 'ALIGNERS', 'Both', 'UPPER', '022 ', '020', '', ' ', null, [], {}, 22, true, ['022']]) {
   expect((await POST(request({ ...body, [field]: value }))).status).toBe(400);
   expect(createOrthoCase).not.toHaveBeenCalled();
   expect(recordAudit).not.toHaveBeenCalled();
  }
 });
 it.each([
  ['appliance', ['fixed_metal', 'fixed_ceramic', 'aligners', 'removable', 'functional']],
  ['arches', ['upper', 'lower', 'both']],
  ['slot', ['018', '022']],
 ] as const)('accepts each exact supported %s unchanged', async (field, values) => {
  for (const value of values) {
   expect((await POST(request({ ...body, [field]: value }))).status).toBe(201);
   expect(vi.mocked(createOrthoCase).mock.lastCall?.[0]).toMatchObject({ [field]: value });
  }
 });
 it('preserves writer state conflict', async () => {
  vi.mocked(createOrthoCase).mockResolvedValue({ ok: false, message: 'Synthetic open-case conflict' });
  const response = await POST(request());
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ message: 'Synthetic open-case conflict' });
  expect(recordAudit).not.toHaveBeenCalled();
 });
 it.each([400, 401, 403, 409] as const)('maps transaction authority status %s and its public code', async status => {
  vi.mocked(createOrthoCase).mockRejectedValue(new OrthoCreateAuthorityError(status, 'create_scope_changed', 'تعذر اعتماد الطلب في نطاقه الحالي.'));
  const response = await POST(request());
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ message: 'تعذر اعتماد الطلب في نطاقه الحالي.', code: 'create_scope_changed' });
  expect(recordAudit).not.toHaveBeenCalled();
 });
 it('does not expose private errors from unexpected writer failures', async () => {
  vi.mocked(createOrthoCase).mockRejectedValue(new Error('private synthetic error'));
  const response = await POST(request());
  expect(response.status).toBe(500); expect(await response.text()).not.toContain('private synthetic error');
  expect(recordAudit).not.toHaveBeenCalled();
 });
});

describe('creation identity admission', () => {
 it.each(['patientId', 'planId'])('rejects malformed %s before lookups or writes', async field => {
  for (const value of [true, false, [], [101], {}, {toString:null,valueOf:null}, 0, -1, 1.1,
   2147483648, Number.MAX_SAFE_INTEGER + 1, 'not-an-id', '101.00000000000000001',
   '1e2', '0x65', '+101', '0101', ' 101 ', '9007199254740993']) {
   expect((await POST(request({...body, [field]:value}))).status).toBe(400);
   expect(canAccessPatient).not.toHaveBeenCalled();
   expect(canChangeOrthoPlanLink).not.toHaveBeenCalled();
   expect(createOrthoCase).not.toHaveBeenCalled();
   expect(recordAudit).not.toHaveBeenCalled();
  }
 });
 it.each([undefined, null, '', '  '])('rejects missing patient identity %j', async patientId => {
  expect((await POST(request({...body,patientId}))).status).toBe(400);
  expect(canAccessPatient).not.toHaveBeenCalled();
 });
 it.each([undefined, null, '', '  '])('preserves deliberate absent plan %j', async planId => {
  expect((await POST(request({...body,planId}))).status).toBe(201);
  expect(vi.mocked(createOrthoCase).mock.lastCall?.[0].planId).toBeNull();
  expect(canChangeOrthoPlanLink).not.toHaveBeenCalled();
 });
 it.each([1, '1', 2147483647, '2147483647'])('admits exact storage-bounded identity %j', async id => {
  expect((await POST(request({...body,patientId:id,planId:id}))).status).toBe(201);
  expect(vi.mocked(createOrthoCase).mock.lastCall?.[0]).toMatchObject({patientId:Number(id),planId:Number(id)});
 });
});


describe('creation date admission', () => {
 it.each(['2026/03/01', '2026-02-30', '2025-02-29', '1900-02-29', '0000-01-01',
  '2026-00-01', '2026-13-01', '2026-01-00', '2026-04-31', '2026-1-01',
  '2026-03-01T00:00:00Z', ' 2026-03-01 ', '10000-01-01', 20260301, true, false,
  [], ['2026-03-01'], {}, {toString:null,valueOf:null}].map(startDate => ({startDate})))('rejects supplied invalid date $startDate before writing', async ({startDate}) => {
  expect((await POST(request({...body,startDate}))).status).toBe(400);
  expect(createOrthoCase).not.toHaveBeenCalled();
  expect(recordAudit).not.toHaveBeenCalled();
 });
 it.each(['0001-01-01', '0099-12-31', '1900-02-28', '2000-02-29', '2028-02-29', '9999-12-31'])('preserves exact calendar date %s', async startDate => {
  expect((await POST(request({...body,startDate}))).status).toBe(201);
  expect(vi.mocked(createOrthoCase).mock.lastCall?.[0].startDate).toBe(startDate);
 });
 it.each([undefined,null,'','  ','\t\n'])('preserves clinic-today fallback for absent/blank %j', async startDate => {
  vi.useFakeTimers();
  try {
   vi.setSystemTime(new Date('2026-11-07T22:30:00Z'));
   expect((await POST(request({...body,startDate}))).status).toBe(201);
   expect(vi.mocked(createOrthoCase).mock.lastCall?.[0].startDate).toBe('2026-11-08');
  } finally { vi.useRealTimers(); }
 });
});

const invalidDurations: unknown[] = [true,false,[],[18],['18'],{}, {toString:null,valueOf:null},18.6,'18.6',0.6,120.4,0,121,-1,'', ' ', 'NaN','Infinity','18.00000000000000001','119.99999999999999999','1e-9999'];
describe('creation duration admission', () => {
 it.each(invalidDurations.map(value=>({value})))('rejects duration $value before writer',async({value})=>{
  const response=await POST(request({...body,plannedMonths:value}));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({message:'المدة المتوقعة بين شهر و120 شهرًا.'});
  expect(createOrthoCase).not.toHaveBeenCalled();
  expect(recordAudit).not.toHaveBeenCalled();
 });
 it.each([undefined,null,1,18,120,'1','120','18.0',' 18 ','+18','018','1.8e1','180e-1','0x12','0o22','0b10010','.18e2','18.00000000000000000'].map(value=>({value})))('admits exact whole duration $value',async({value})=>{
  expect((await POST(request({...body,plannedMonths:value}))).status).toBe(201);
  expect(vi.mocked(createOrthoCase).mock.lastCall?.[0].plannedMonths).toBe(Number(value??18));
 });
});
