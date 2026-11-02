import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DoseProfileForm, PrescriptionDoseProfiles } from '../components/PrescriptionDoseProfiles';

const state = vi.hoisted(() => ({ selected: '' }));
vi.mock('../components/SessionProvider', () => ({
  useSessionActions: () => ({ ready: true, session: { username: 'synthetic-reviewer', role: 'doctor', permissions: [] } }),
}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  // The actual select handler changes this one chooser state. This is a
  // component/server-render test, not a DOM, browser or React lifecycle test.
  useState: () => [state.selected, (value: string) => { state.selected = value; }],
}));
type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  return [node as Element, ...nodes((node as Element).props.children as ReactNode)];
}
function chooser(onSelect: ReturnType<typeof vi.fn>): Element {
  const outer = PrescriptionDoseProfiles({ onSelect });
  return (outer.type as (props: unknown) => Element)(outer.props);
}
beforeEach(() => { state.selected = ''; });

describe('actual reference chooser selection and server-rendered safety text', () => {
  it.each([
    ['coamoxiclav-child-label-q12', '12 أسبوعًا فأكثر وأقل من 40 kg؛ عند 40 kg فأكثر يُراجع مسار البالغ وفق نشرة المنتج، ولا تحويل تلقائي.'],
    ['benzydamine-rinse-label', 'لا يُنصح به عند فرط الحساسية للأسبرين أو مضادات الالتهاب غير الستيرويدية، ويستلزم الحذر عند وجود ربو حالي أو سابق.'],
  ])('renders corrected %s text without a numeric form or transfer action', (profileId, expectedText) => {
    const onSelect = vi.fn();
    const select = nodes(chooser(onSelect)).find(node => node.props['aria-label'] === 'الملف المرجعي للجرعة');
    expect(select).toBeDefined();
    (select!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: profileId } });
    const tree = chooser(onSelect);
    expect(state.selected).toBe(profileId);
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
