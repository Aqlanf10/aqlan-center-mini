import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selection: vi.fn(), session: vi.fn(), allowed: vi.fn(), document: vi.fn(), file: vi.fn(), canonicalFile: vi.fn(),
}));
vi.mock('@/lib/staff-session-admission', () => ({ selectRequestStaffEnvelope: mocks.selection }));
vi.mock('@/lib/session', () => ({ requireSession: mocks.session }));
vi.mock('@/lib/patient-access', () => ({ canAccessPatient: mocks.allowed }));
vi.mock('@/lib/db', () => ({ getDocumentForDownload: mocks.document, recordAudit: vi.fn(), removeDocument: vi.fn() }));
vi.mock('@/lib/files', () => ({ readFileByKey: mocks.file }));
vi.mock('@/lib/canonical-documents', () => ({ readCanonicalDocumentFile: mocks.canonicalFile, canonicalDocumentFailure: vi.fn(), commandCanonicalDocumentHide: vi.fn() }));
import { GET } from '@/app/api/documents/[id]/route';

const bytes = Buffer.from('synthetic bytes');
const request = () => new Request('http://127.0.0.1/api/documents/1');
const context = () => ({ params: Promise.resolve({ id: '1' }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ role: 'doctor' });
  mocks.allowed.mockResolvedValue(true);
  mocks.document.mockResolvedValue({ document: { patientId: 9, title: 'synthetic', mimeType: 'image/png', removedAt: null }, storageKey: 'synthetic' });
  mocks.file.mockResolvedValue(bytes);
  mocks.canonicalFile.mockResolvedValue({ document: { title: 'synthetic', mimeType: 'image/png' }, bytes });
});

it.each(['legacy', 'canonical'])('sets the exact length, bytes and private headers in the %s handler response', async mode => {
  mocks.selection.mockResolvedValue(mode === 'canonical' ? { kind: mode, handle: {} } : { kind: mode });
  const response = await GET(request(), context());
  expect(response.status).toBe(200);
  expect(response.headers.get('content-length')).toBe(String(bytes.length));
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
});

it('refuses an unauthorized legacy read before touching storage', async () => {
  mocks.selection.mockResolvedValue({ kind: 'legacy' });
  mocks.allowed.mockResolvedValue(false);
  expect((await GET(request(), context())).status).toBe(403);
  expect(mocks.file).not.toHaveBeenCalled();
});
