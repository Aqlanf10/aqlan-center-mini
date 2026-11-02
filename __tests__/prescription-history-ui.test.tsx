import type { ReactElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
 useState: (initial: unknown) => { const i = state.cursor++; if (!(i in state.values)) state.values[i] = initial; return [state.values[i], (next: unknown) => { state.values[i] = typeof next === 'function' ? next(state.values[i]) : next; }]; },
 useRef: (initial: unknown) => { const i = state.cursor++; if (!(i in state.values)) state.values[i] = { current: initial }; return state.values[i]; },
 useEffect: () => {},
}));
vi.mock('../components/SessionProvider', () => ({ useSession: () => ({ username: 'synthetic', role: 'doctor' }) }));
import { SavedPrescriptions } from '../components/SavedPrescriptions';
const fetchMock = vi.fn();
beforeEach(() => { state.values = []; state.cursor = 0; fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
function render() {
 state.cursor = 0;
 const root = SavedPrescriptions({ patientId: 7 }) as ReactElement<{ patientId: number }>;
 return (root.type as (props: typeof root.props) => ReactElement)(root.props);
}
function buttons(node: unknown): ReactElement<{ onClick: () => void; children: unknown }>[] {
 if (Array.isArray(node)) return node.flatMap(buttons);
 if (!node || typeof node !== 'object' || !('props' in node)) return [];
 const element = node as ReactElement<{ children: unknown }>;
 return element.type === 'button' ? [element as ReactElement<{ onClick: () => void; children: unknown }>] : buttons(element.props.children);
}
const result = (body: object, status = 200) => new Response(JSON.stringify(body), { status });
const clinical = { mode: 'clinical-history', prescriptions: [{ id: 81, items: [{ name: 'PrivateSyntheticMedication' }], status: 'void' }], nextCursor: 'next' };
async function click(index: number) { buttons(render())[index].props.onClick(); await vi.waitFor(() => { expect(state.values[4]).toBe(false); }); }
it('drops prior clinical content when a load-more response downgrades to minimal print access', async () => {
 fetchMock.mockResolvedValueOnce(result(clinical)); await click(0); expect(JSON.stringify(render())).toContain('PrivateSyntheticMedication');
 fetchMock.mockResolvedValueOnce(result({ prescriptions: [{ id: 82, visitId: null, createdAt: '2026-11-01', prescribingDoctorName: null }], nextCursor: null }));
 await click(1); expect(JSON.stringify(render())).not.toContain('PrivateSyntheticMedication'); expect(JSON.stringify(render())).toContain('82');
});
it('clears already displayed history and cursor on forbidden load-more', async () => {
 fetchMock.mockResolvedValueOnce(result(clinical)); await click(0);
 fetchMock.mockResolvedValueOnce(result({ message: 'Forbidden synthetic' }, 403)); await click(1);
 expect(JSON.stringify(render())).not.toContain('PrivateSyntheticMedication'); expect(buttons(render())).toHaveLength(1);
});
