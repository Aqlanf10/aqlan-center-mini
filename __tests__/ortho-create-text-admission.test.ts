import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/session', () => ({ requireSession: vi.fn() }));
vi.mock('@/lib/patient-access', () => ({ canAccessPatient: vi.fn() }));
vi.mock('@/lib/ortho-plan-link-access', () => ({ canChangeOrthoPlanLink: vi.fn() }));
vi.mock('@/lib/db', () => ({ CLINIC_TIME_ZONE: 'Asia/Aden', createOrthoCase: vi.fn(), recordAudit: vi.fn() }));
import { POST } from '@/app/api/ortho/route';
import { requireSession } from '@/lib/session';
import { canAccessPatient } from '@/lib/patient-access';
import { canChangeOrthoPlanLink } from '@/lib/ortho-plan-link-access';
import { createOrthoCase } from '@/lib/db';
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

describe.each([['bracketSystem', 80], ['note', 300]] as const)('%s lossless text admission', (field, limit) => {
 it.each([true, false, 0, 12, [], ['text'], {}, {value:'text'}, 'x'.repeat(limit+1), 'x'.repeat(limit-1)+'🦷', '\u0000', '\ud800', '\udc00'])('rejects malformed or oversized value %j before writer', async value => {
  expect((await POST(request({...body,[field]:value}))).status).toBe(400);
  expect(createOrthoCase).not.toHaveBeenCalled();
 });
 it.each([undefined, null, '', '  ', '\t\n', 'MBT عربي é 🦷\nSecond line', 'x'.repeat(limit), '🦷'.repeat(limit/2), '\uFFFD', 'A\u200dB'])('preserves supported value %j unchanged at writer boundary', async value => {
  expect((await POST(request({...body,[field]:value}))).status).toBe(201);
  expect(createOrthoCase).toHaveBeenCalledWith(expect.objectContaining({[field]:value ?? null}), expect.anything());
 });
});
