import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DoseProfileForm, PrescriptionDoseProfiles } from '../components/PrescriptionDoseProfiles';

const state = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('../components/SessionProvider', () => ({
  useSessionActions: () => ({ ready: true, session: { username: 'synthetic-reviewer', role: 'doctor', permissions: [] } }),
}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  // Keep a separate stable slot for each chooser hook. This exercises the
  // actual select handler, but is not a browser or React lifecycle test.
  useRef: (initial: unknown) => {
    const slot = state.cursor++;
    if (!(slot in state.values)) state.values[slot] = { current: initial };
    return state.values[slot];
  },
  useLayoutEffect: (effect: () => void | (() => void)) => { state.cursor++; effect(); },
  useState: (initial: unknown) => {
    const slot = state.cursor++;
    if (!(slot in state.values)) state.values[slot] = initial;
    return [state.values[slot], (value: unknown) => { state.values[slot] = typeof value === 'function' ? value(state.values[slot]) : value; }];
  },
}));
type Element = ReactElement<Record<string, unknown>>;
type OnSelect = ComponentProps<typeof PrescriptionDoseProfiles>['onSelect'];
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  return [node as Element, ...nodes((node as Element).props.children as ReactNode)];
}
function chooser(onSelect: OnSelect): Element {
  const outer = PrescriptionDoseProfiles({ onSelect });
  state.cursor = 0;
  return (outer.type as (props: unknown) => Element)(outer.props);
}
beforeEach(() => { state.values = []; state.cursor = 0; });

describe('actual reference chooser selection and server-rendered safety text', () => {
  it.each([
    ['coamoxiclav-child-label-q12', '12 أسبوعًا فأكثر وأقل من 40 kg؛ عند 40 kg فأكثر يُراجع مسار البالغ وفق نشرة المنتج، ولا تحويل تلقائي.'],
    ['benzydamine-rinse-label', 'لا يُنصح به عند فرط الحساسية للأسبرين أو مضادات الالتهاب غير الستيرويدية، ويستلزم الحذر عند وجود ربو حالي أو سابق.'],
  ])('renders corrected %s text without a numeric form or transfer action', (profileId, expectedText) => {
    const onSelect = vi.fn<OnSelect>();
    const select = nodes(chooser(onSelect)).find(node => node.props['aria-label'] === 'الملف المرجعي للجرعة');
    expect(select).toBeDefined();
    (select!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: profileId } });
    const tree = chooser(onSelect);
    expect(nodes(tree).find(node => node.props['aria-label'] === 'الملف المرجعي للجرعة')?.props.value).toBe(profileId);
    expect(nodes(tree).some(node => node.type === DoseProfileForm)).toBe(false);
    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain(expectedText);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('تحويله العددي لم يُراجع');
    expect(markup).not.toContain('data-dose-form');
    expect(markup).not.toContain('نقل الجرعة والتعليمات إلى مسودة غير مؤكدة');
    expect(onSelect).not.toHaveBeenCalled();
    if (profileId === 'benzydamine-rinse-label') {
      expect(markup).toContain('حساسيةالمنتج؛ تحقق منالسواغات والكحول، لا يستخدمغسول≤12سنة، لايبلع؛ الحمل/الرضاعة حسبالنشرة.');
    }
  });
});

