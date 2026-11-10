import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../components/SessionProvider';
const state = vi.hoisted(() => ({ session: null as SessionInfo | null }));
vi.mock('../components/SessionProvider', () => ({ useSession: () => state.session }));
import { OrthoStudyExportLinks } from '../components/OrthoStudyExportLinks';
const props = { patientId: 11, orthoCaseId: 21, revisionId: 31 };
const render = (selected = props) => renderToStaticMarkup(<OrthoStudyExportLinks {...selected} />);
beforeEach(() => { state.session = null; });
it('keeps four outputs bound to the selected patient/case/revision for an authorized actor', () => {
  state.session = { username: 'Synthetic', role: 'admin' };
  const html = render();
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1].replaceAll('&amp;', '&'), 'https://synthetic.invalid'));
  expect(links).toHaveLength(4);
  expect(links.map(link => link.pathname)).toEqual(['/print/ortho-study/21', '/api/ortho/21/case-study/text-pptx', '/api/ortho/21/case-study/illustrated-pptx', '/print/ortho-study/21']);
  for (const link of links) { expect(link.searchParams.get('patientId')).toBe('11'); expect(link.searchParams.get('revisionId')).toBe('31'); }
  expect(links[3].searchParams.get('mode')).toBe('full');
  expect(links.slice(0, 3).every(link => !link.searchParams.has('mode'))).toBe(true);
  expect(html).toContain('معاينة الدراسة المصورة / PDF');
  expect(html.match(/target="_blank" rel="noopener noreferrer"/g)).toHaveLength(2);
});
it.each(['doctor', 'reception'] as const)('withdraws all export links when the displayed %s grant is revoked without offering to discard the study', role => {
  state.session = { username: 'Synthetic', role, permissions: { canExportOrthoStudies: true } as SessionInfo['permissions'] };
  const granted = render();
  expect(granted.match(/href=/g)).toHaveLength(4);
  expect(granted).toContain('revisionId=31&amp;mode=full');
  state.session = { ...state.session, permissions: { canExportOrthoStudies: false } as SessionInfo['permissions'] };
  const denied = render();
  expect(denied).not.toContain('href=');
  expect(denied).toContain('تبقى مراجعة الدراسة المحفوظة متاحة');
  expect(denied).not.toContain('<button');
  state.session = { ...state.session, permissions: null }; expect(render()).not.toContain('href=');
  state.session = null; expect(render()).not.toContain('href=');
});

it('updates the full-preview scope when the selected saved revision and case change', () => {
  state.session = { username: 'Synthetic', role: 'admin' };
  render();
  const html = render({ patientId: 12, orthoCaseId: 22, revisionId: 32 });
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1].replaceAll('&amp;', '&'), 'https://synthetic.invalid'));
  expect(links).toHaveLength(4);
  expect(links[3].pathname).toBe('/print/ortho-study/22');
  expect([...links[3].searchParams]).toEqual([['patientId', '12'], ['revisionId', '32'], ['mode', 'full']]);
  for (const link of links) { expect(link.searchParams.get('patientId')).toBe('12'); expect(link.searchParams.get('revisionId')).toBe('32'); }
  expect(html).not.toContain('mode=illustrated');
});
