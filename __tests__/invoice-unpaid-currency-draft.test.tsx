import { isValidElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (initial: unknown) => {
  const slot = state.cursor++;
  if (!(slot in state.slots)) state.slots[slot] = initial;
  return [state.slots[slot], (value: unknown) => { state.slots[slot] = typeof value === 'function' ? value(state.slots[slot]) : value; }];
} }));
import { UnpaidCurrencyCorrectionReview } from '../components/UnpaidCurrencyCorrectionReview';
const source = { patientId: 1, invoiceId: 2, sourceHash: 'a'.repeat(64), currency: 'YER' as const, totalMinor: 100, discountMinor: 0, lines: [{ itemId: 3, quantity: 1, unitPriceMinor: 100 }] };
type Control = { value?: string; disabled?: boolean; onChange?: (event: { target: { value: string } }) => void; children?: ReactNode };
function controls() {
  state.cursor = 0;
  const rows: Array<{ type: unknown; props: Control }> = [];
  function walk(node: ReactNode) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isValidElement<Control>(node)) return;
    if (node.type === 'input' || node.type === 'select' || node.type === 'button') rows.push({ type: node.type, props: node.props });
    walk(node.props.children);
  }
  walk(UnpaidCurrencyCorrectionReview({ source })); return rows;
}
const change = (control: { props: Control }, value: string) => control.props.onChange!({ target: { value } });
beforeEach(() => { state.slots = []; state.cursor = 0; });
it('preserves exact reviewed draft strings across mode and target changes, without guessing or sending', () => {
  let rows = controls(); change(rows[0], 'SAR'); change(rows[1], 'reviewed-target-amounts');
  rows = controls(); const inputs = rows.filter(row => row.type === 'input');
  expect(inputs.map(row => row.props.value)).toEqual(['', '', '']);
  change(inputs[0], 'تصحيح العملة'); change(inputs[1], '12.3400'); change(inputs[2], '0.00');
  rows = controls(); change(rows[1], 'preserve-numerals');
  rows = controls(); expect(rows.filter(row => row.type === 'input').map(row => row.props.value)).toEqual(['تصحيح العملة']);
  change(rows[0], 'USD'); change(rows[1], 'reviewed-target-amounts');
  rows = controls(); expect(rows.filter(row => row.type === 'input').map(row => row.props.value)).toEqual(['تصحيح العملة', '12.3400', '0.00']);
  expect(rows.find(row => row.type === 'button')!.props.disabled).toBe(true);
});
