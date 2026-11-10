import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../components/SessionProvider';
const state = vi.hoisted(() => ({ session: null as SessionInfo | null }));
vi.mock('../components/SessionProvider', () => ({ useSession: () => state.session }));
import { OrthoStudyExportLinks } from '../components/OrthoStudyExportLinks';
const props = { patientId: 11, orthoCaseId: 21, revisionId: 31 };
const render = () => renderToStaticMarkup(<OrthoStudyExportLinks {...props} />);
beforeEach(() => { state.session = null; });
it('keeps four outputs bound to the selected patient/case/revision for an authorized actor', () => {
  state.session = { username: 'Synthetic', role: 'admin' };
  const html = render();
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1].replaceAll('&amp;', '&'), 'https://synthetic.invalid'));
  expect(links).toHaveLength(4);
  expect(links.map(link => link.pathname)).toEqual(['/print/ortho-study/21', '/api/ortho/21/case-study/text-pptx', '/api/ortho/21/case-study/illustrated-pptx', '/print/ortho-study/21']);
  for (const link of links) { expect(link.searchParams.get('patientId')).toBe('11'); expect(link.searchParams.get('revisionId')).toBe('31'); }
  expect(links[3].searchParams.get('mode')).toBe('illustrated');
});
it('withdraws all export links when the displayed grant is revoked without offering to discard the study', () => {
  state.session = { username: 'Synthetic', role: 'doctor', permissions: { canExportOrthoStudies: true } as SessionInfo['permissions'] };
  expect(render()).toContain('href=');
  state.session = { ...state.session, permissions: null };
  const denied = render();
  expect(denied).not.toContain('href=');
  expect(denied).toContain('تبقى مراجعة الدراسة المحفوظة متاحة');
  expect(denied).not.toContain('<button');
  state.session = null; expect(render()).not.toContain('href=');
});
