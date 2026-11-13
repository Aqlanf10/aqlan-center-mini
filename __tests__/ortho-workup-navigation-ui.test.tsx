import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { OrthoCaseNavigation, OrthoWorkupNavigation } from "../components/OrthoWorkupNavigation";
import { ORTHO_CASE_PILLARS, ORTHO_WORKUP_GROUPS, ORTHO_WORKUP_STEPS } from "../lib/ortho-workup-navigation";

// Actual stateless component handlers, without a DOM or browser layout claim.
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
function buttons(tree: ReactNode, navigation: string) {
  const nav = nodes(tree).find(node => node.type === "nav" && node.props["aria-label"] === navigation)!;
  expect(nav).toBeDefined(); return nodes(nav).filter(node => node.type === "button");
}
const click = (button: Element) => (button.props.onClick as () => void)();

describe("consistent case and workup tab order", () => {
  it("shows the clinical lifecycle order in both views without modifying anything during render", () => {
    const select = vi.fn(), close = vi.fn();
    const cases = OrthoCaseNavigation({ pillar: "wires", onSelect: select });
    const workup = OrthoWorkupNavigation({ step: 10, legacy: false, onSelect: select, onClose: close });
    const caseButtons = buttons(cases, "أقسام حالة التقويم"), groupButtons = buttons(workup, "مجموعات ملف التقويم");
    expect(caseButtons.map(button => button.props["aria-label"])).toEqual(["الفحص والتشخيص", "خطة العلاج والميكانيكا", "زيارات المتابعة والشدّ", "التثبيت والإقفال", "دراسة الحالة المحفوظة"]);
    expect(caseButtons.map(button => button.props["aria-label"])).toEqual(ORTHO_CASE_PILLARS.map(item => item.title));
    expect(groupButtons.map(text)).toEqual(ORTHO_WORKUP_GROUPS.map(group => group.title));
    // The case view's sections and the workup groups follow the same pillar order.
    expect([...new Set(ORTHO_WORKUP_GROUPS.map(group => group.pillar))]).toEqual(ORTHO_CASE_PILLARS.map(item => item.id));
    expect(caseButtons.map(button => button.props["aria-pressed"])).toEqual([false, false, true, false, false]);
    expect(groupButtons.map(button => button.props["aria-pressed"])).toEqual([false, false, false, false, true, false, false]);
    for (const button of caseButtons) {
      expect(button.props.type).toBe("button");
      expect(button.props.className).toContain("min-h-11");
      expect(nodes(button).some(node => String(node.props.className ?? "").includes("hidden"))).toBe(false);
    }
    expect(select).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    click(caseButtons[0]); expect(select).toHaveBeenCalledExactlyOnceWith("diagnostics");
  });

  it("opens the interview from examination but does not reset an already selected examination section", () => {
    const select = vi.fn();
    let tree = OrthoWorkupNavigation({ step: 10, legacy: false, onSelect: select, onClose: vi.fn() });
    click(buttons(tree, "مجموعات ملف التقويم")[1]); expect(select).toHaveBeenLastCalledWith(1);
    tree = OrthoWorkupNavigation({ step: 4, legacy: false, onSelect: select, onClose: vi.fn() });
    click(buttons(tree, "مجموعات ملف التقويم")[1]); expect(select).toHaveBeenLastCalledWith(4);
    const sections = buttons(tree, "أقسام الفحص والسجلات");
    expect(sections.map(text)).toEqual(ORTHO_WORKUP_GROUPS[1].steps.map(step => ORTHO_WORKUP_STEPS[step].title));
    click(sections[5]); expect(select).toHaveBeenLastCalledWith(6);
    expect(sections.filter(button => button.props["aria-current"] === "page").map(text)).toEqual(["القياسات وتحليل الموديلات"]);
  });

  it("only requests destinations and closing through the parent's existing admission handlers", () => {
    const select = vi.fn(), close = vi.fn();
    const tree = OrthoWorkupNavigation({ step: 1, legacy: true, onSelect: select, onClose: close });
    const groupButtons = buttons(tree, "مجموعات ملف التقويم");
    for (const button of groupButtons) click(button);
    expect(select.mock.calls.map(call => call[0])).toEqual([0, 1, 7, 8, 10, 11, 12]);
    click(nodes(tree).find(node => node.type === "button" && text(node) === "العودة لأقسام الحالة")!);
    expect(close).toHaveBeenCalledTimes(1);
    expect(OrthoWorkupNavigation({ step: -1, legacy: false, onSelect: select, onClose: close })).toBeNull();
  });
});
