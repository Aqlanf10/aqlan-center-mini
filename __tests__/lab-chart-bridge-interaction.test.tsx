import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>();
  return { ...actual, useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value; }];
  }, useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn, useEffect: () => {} };
});
import { LabDentalChart } from '../components/LabDentalChart';
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const el = node as Element;
  if (typeof el.type === 'function') return elements((el.type as (props: Record<string, unknown>) => ReactNode)(el.props));
  return [el, ...elements(el.props.children as ReactNode)];
}
let props: Parameters<typeof LabDentalChart>[0] = {};
function render() { hooks.cursor = 0; return elements(LabDentalChart(props)); }
function click(predicate: (el: Element) => boolean) {
  const node = render().find(predicate); expect(node).toBeDefined(); (node!.props.onClick as () => void)();
}
const wizard = (el: Element) => el.props.title === 'حدد سن البداية ثم سن النهاية ليتم بناء الجسر آلياً';
const tooth = (code: number) => (el: Element) => el.props['data-tooth-code'] === code;
beforeEach(() => { hooks.values = []; hooks.cursor = 0; props = {}; });
describe('actual lab bridge handlers', () => {
  it.each(['cancel', 'tool', 'same-start'])('clears an invalid-endpoint alert when leaving via %s', exit => {
    click(wizard); click(tooth(11)); click(tooth(41));
    expect(render().some(el => el.props.role === 'alert')).toBe(true);
    if (exit === 'cancel') click(wizard);
    if (exit === 'tool') click(el => el.props.title === 'إزالة السن من طلب المختبر');
    if (exit === 'same-start') click(tooth(11));
    expect(render().some(el => el.props.role === 'alert')).toBe(false);
  });
  it('makes a cross-midline bridge on the correct anatomical teeth only', () => {
    click(wizard); click(tooth(13)); click(tooth(23));
    const selected = render().filter(el => el.props['data-tooth-code'] && el.props['aria-pressed']).map(el => el.props['data-tooth-code']);
    expect(selected).toEqual([13, 12, 11, 21, 22, 23]);
  });
});


describe("work-appropriate chart roles", () => {
  it("uses denture teeth instead of crowns and hides bridge creation", () => {
    const changed = vi.fn(); props = { workType: "طقم جزئي", onChange: changed };
    expect(render().find(wizard)?.props.disabled).toBe(true);
    click(tooth(11));
    expect(changed.mock.calls.at(-1)?.[1]).toEqual({ 11: "denture_tooth" });
  });
  it("preserves saved crowns on a work change until explicit tooth edits", () => {
    const changed = vi.fn(); props = { value: "11(Crown)", workType: "تاج", onChange: changed };
    render(); props = { ...props, workType: "طقم جزئي" }; render();
    expect(changed).not.toHaveBeenCalled();
    click(tooth(21));
    expect(changed.mock.calls.at(-1)?.[1]).toEqual({ 11: "crown", 21: "denture_tooth" });
  });
});
