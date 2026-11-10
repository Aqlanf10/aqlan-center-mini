import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  read: vi.fn(), image: vi.fn(), render: vi.fn(), audit: vi.fn(),
  session: { userId: 7, username: 'Synthetic', role: 'doctor' as const, expiresAt: Number.MAX_SAFE_INTEGER },
}));
vi.mock('../lib/ortho-case-study-store', () => ({ getOrthoCaseStudy: state.read }));
vi.mock('../lib/ortho-study-image-store', () => ({ getStudyImagePreview: state.image }));
vi.mock('../lib/ortho-study-illustrated', () => ({ illustrateSavedStudy: async (_revision: unknown, _scope: unknown, image: (use: unknown, frame: unknown) => Promise<unknown>) => {
  await image({ documentId: 9, sourceSha256: 'a'.repeat(64), useId: 'one', recipe: {} }, { width: 10, height: 10 });
  await image({ documentId: 10, sourceSha256: 'b'.repeat(64), useId: 'two', recipe: {} }, { width: 10, height: 10 });
  return { revisionHash: 'c'.repeat(64) };
} }));
vi.mock('../lib/ortho-journey-route', () => ({
  admitJourney: async () => ({ ok: true, session: state.session }),
  journeyRouteOwner: async () => ({ ok: true, session: state.session, patientId: 11, orthoCaseId: 21 }),
  routeId: (raw: string | null) => raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : null,
  journeyRouteError: (status: number, code: string) => Response.json({ code }, { status }),
}));
vi.mock('../lib/ortho-study-text-export', () => ({ studyTextPresentation: () => ({ revisionHash: 'c'.repeat(64), version: 1, pages: [{}] }) }));
vi.mock('../lib/ortho-study-pptx', () => ({ renderStudyTextPptx: state.render }));
vi.mock('../lib/db', () => ({ recordAudit: state.audit }));
import { withIllustratedStudy } from '../lib/ortho-study-illustrated-store';
import { GET } from '../app/api/ortho/[id]/case-study/text-pptx/route';
const input = { session: state.session, patientId: 11, orthoCaseId: 21, revisionId: 31 };
const allowed = { ok: true, revision: { id: 31, contentHash: 'c'.repeat(64) } };
const denied = { ok: false, status: 403, code: 'study_export_forbidden' };
beforeEach(() => {
  vi.clearAllMocks(); state.read.mockReset().mockResolvedValue(allowed); state.image.mockReset().mockResolvedValue({ ok: true });
  state.render.mockReset().mockResolvedValue(Buffer.from('Synthetic prepared bytes')); state.audit.mockReset().mockResolvedValue(undefined);
});
it('checks the illustrated export at admission, on every asset, and after the consumer finishes', async () => {
  const consume = vi.fn(async () => 'Synthetic output');
  expect(await withIllustratedStudy(input, consume)).toMatchObject({ ok: true, output: 'Synthetic output' });
  expect(state.read).toHaveBeenCalledTimes(2);
  for (const [arg] of state.read.mock.calls) expect(arg).toEqual({ ...input, exportAccess: true });
  expect(state.image).toHaveBeenCalledTimes(2);
  expect(state.image.mock.calls.map(([arg]) => [arg.exportAccess, arg.command.documentId])).toEqual([[true, 9], [true, 10]]);
  expect(state.read.mock.invocationCallOrder[1]).toBeGreaterThan(consume.mock.invocationCallOrder[0]);
});
it('does not fetch assets when admission denies export or release output when the final check denies it', async () => {
  const consume = vi.fn(async () => 'Must not escape');
  state.read.mockResolvedValueOnce(denied);
  expect(await withIllustratedStudy(input, consume)).toEqual(denied); expect(state.image).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled();
  state.read.mockResolvedValueOnce(allowed).mockResolvedValueOnce(denied);
  expect(await withIllustratedStudy(input, consume)).toEqual(denied); expect(consume).toHaveBeenCalledOnce();
});
it('stops before encoding when an export asset is denied and releases its process slot', async () => {
  const consume = vi.fn(async () => 'Must not escape'); state.image.mockResolvedValueOnce(denied);
  await expect(withIllustratedStudy(input, consume)).rejects.toThrow('study_export_forbidden');
  expect(consume).not.toHaveBeenCalled();
  expect(await withIllustratedStudy(input, consume)).toMatchObject({ ok: true });
});
it('checks text export again after audit and withholds prepared bytes if that grant was revoked', async () => {
  state.audit.mockImplementation(async () => { state.read.mockResolvedValueOnce(denied); });
  const response = await GET(new Request('https://synthetic.invalid/api/ortho/21/case-study/text-pptx?patientId=11&revisionId=31'), { params: Promise.resolve({ id: '21' }) });
  expect(response.status).toBe(403); expect(await response.text()).not.toContain('Synthetic prepared bytes');
  expect(state.read).toHaveBeenCalledTimes(2);
  for (const [arg] of state.read.mock.calls) expect(arg).toMatchObject({ exportAccess: true, patientId: 11, orthoCaseId: 21, revisionId: 31 });
  expect(state.read.mock.invocationCallOrder[1]).toBeGreaterThan(state.audit.mock.invocationCallOrder[0]);
});
