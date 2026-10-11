import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { TreatmentEntryChoice } from "../components/TreatmentEntryChoice";
import { canLeaveTreatmentEntry } from "../lib/treatment-entry-navigation";

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  return value && typeof value === "object" && "props" in value
    ? [value as Node, ...nodes((value as Node).props.children as ReactNode)] : [];
}
const buttons = (disabled = false, canAddLegacy = true, onSelect = vi.fn()) =>
  nodes(TreatmentEntryChoice({ disabled, canAddLegacy, onSelect })).filter(node => node.type === "button");
const click = (button: Node) => (button.props.onClick as () => void)();

describe("single explicit treatment origin", () => {
  it("renders two explicit choices without selecting or writing on render", () => {
    const select = vi.fn();
    expect(buttons(false, true, select)).toHaveLength(2);
    expect(select).not.toHaveBeenCalled();
    click(buttons(false, true, select)[0]);
    expect(select).toHaveBeenCalledExactlyOnceWith("invoice");
  });
  it("uses the existing legacy path only after an explicit authorized choice", () => {
    const select = vi.fn();
    click(buttons(false, false, select)[1]);
    expect(buttons(false, false, select)[1].props.disabled).toBe(true);
    expect(select).not.toHaveBeenCalled();
    click(buttons(false, true, select)[1]);
    expect(select).toHaveBeenCalledExactlyOnceWith("legacy");
  });
  it("refuses both captured disabled handlers while Account authority is unavailable", () => {
    const select = vi.fn();
    for (const button of buttons(true, true, select)) {
      expect(button.props.disabled).toBe(true); click(button);
    }
    expect(select).not.toHaveBeenCalled();
  });
});

describe("Account treatment draft navigation", () => {
  it.each([false, true])("never leaves an in-flight write, even when confirm would return %s", answer => {
    const confirm = vi.fn(() => answer);
    expect(canLeaveTreatmentEntry({ active: true, pending: true, hasDraft: true }, confirm)).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("retired owners cannot confirm away another patient's current draft", () => {
    const confirm = vi.fn(() => true);
    expect(canLeaveTreatmentEntry({ active: false, pending: false, hasDraft: true }, confirm)).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("keeps a dismissed draft and permits only explicit confirmation", () => {
    const state = { active: true, pending: false, hasDraft: true };
    expect(canLeaveTreatmentEntry(state, () => false)).toBe(false);
    expect(canLeaveTreatmentEntry(state, () => true)).toBe(true);
    const confirm = vi.fn();
    expect(canLeaveTreatmentEntry({ ...state, hasDraft: false }, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
