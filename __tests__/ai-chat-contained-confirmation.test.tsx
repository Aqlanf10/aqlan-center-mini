import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { containedToolRefusal } from "../lib/ai-tools/contained-tools";
import type { ToolConfirmationOffer } from "../lib/ai-tools/types";

/**
 * The assistant chat window's handling of a confirmation that the server refuses as a contained tool
 * (CORE-SAFETY, lib/ai-tools/contained-tools.ts). A payment card issued before containment (a
 * historical token still on screen) is confirmed: the window must show a terminal refused state, keep
 * the original card's evidence, show the server's qualified wording and the safe /finance navigation,
 * and never bring back a retry confirmation. Generic confirmation handling for other tools is unchanged.
 */
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  return { ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? (initial as () => unknown)() : initial);
      return [hooks.values[index], (value: unknown) => {
        hooks.values[index] = typeof value === "function" ? (value as (prev: unknown) => unknown)(hooks.values[index]) : value;
      }];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useEffect: () => {},
    useMemo: (factory: () => unknown) => factory(),
  };
});

const { default: AiStaffChatModal, applyConfirmationResult } = await import("../components/AiStaffChatModal");
type ChatMessage = import("../components/AiStaffChatModal").ChatMessage;

type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...nodes(element.props.children as ReactNode)];
}
const text = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return "props" in (node as object) ? text((node as Element).props.children as ReactNode) : "";
};

const historicalOffer: ToolConfirmationOffer = {
  token: "historical.signed-token", tool: "record_patient_payment", title: "تسجيل سند قبض",
  description: "سند قبض للمريض", patientLabel: "مريض اصطناعي",
  fields: [{ label: "المبلغ", value: "5000 ريال يمني", sensitive: true }, { label: "طريقة القبض", value: "نقدًا بالصندوق", sensitive: true }],
  expiresAt: Date.now() + 60_000,
} as unknown as ToolConfirmationOffer;
const cardMessage = (): ChatMessage => ({ id: "a_offer", role: "assistant", content: "⏳ ينتظر تأكيدك", confirmation: historicalOffer, confirmationState: "pending", timestamp: "10:00" });
/** Exactly what POST /api/ai/confirmation returns for a contained tool: `{ ok, reply, ...result }`. */
const containedPayload = () => { const result = containedToolRefusal(); return { ok: result.success, reply: result.textSummary, ...result }; };
const QUALIFIED = [/في هذه المحاولة/, /محاولةٌ سابقة/, /راجع سندات المريض/];

describe("applyConfirmationResult", () => {
  it("a contained refusal of a historical token is terminal, keeps the card evidence and shows only safe navigation", () => {
    const before = [cardMessage()];
    const after = applyConfirmationResult(before, "a_offer", { responseOk: true, payload: containedPayload(), id: "a_result", timestamp: "10:01" });
    expect(after).toHaveLength(2);
    expect(after[0].confirmationState).toBe("refused");
    expect(after[0].confirmation).toBe(historicalOffer);
    expect(after[0].content).toBe(before[0].content);
    for (const pattern of QUALIFIED) expect(after[1].content).toMatch(pattern);
    expect(after[1].actions).toEqual([{ label: "فتح شاشة التحصيل", href: "/finance", actionType: "navigate" }]);
    expect(after.some((message) => message.confirmationState === "pending")).toBe(false);
  });

  it("only internal navigation survives from a contained payload", () => {
    const payload = { ...containedPayload(), actions: [
      { label: "x", href: "//evil.example/pay", actionType: "navigate" as const },
      { label: "y", href: "https://evil.example", actionType: "navigate" as const },
      { label: "z", href: "/finance", actionType: "whatsapp" as const },
      { label: "فتح شاشة التحصيل", href: "/finance", actionType: "navigate" as const },
    ] };
    const [, result] = applyConfirmationResult([cardMessage()], "a_offer", { responseOk: true, payload, id: "r", timestamp: "t" });
    expect(result.actions).toEqual([{ label: "فتح شاشة التحصيل", href: "/finance", actionType: "navigate" }]);
  });

  it("generic handling for other tools is unchanged: failure returns to pending without buttons, success is done", () => {
    const failed = applyConfirmationResult([cardMessage()], "a_offer", { responseOk: true,
      payload: { ok: false, reply: "تعذّر", actions: [{ label: "x", href: "/finance", actionType: "navigate" }] }, id: "r", timestamp: "t" });
    expect(failed[0].confirmationState).toBe("pending");
    expect(failed[1].actions).toBeUndefined();
    const done = applyConfirmationResult([cardMessage()], "a_offer", { responseOk: true, payload: { ok: true, reply: "تم" }, id: "r", timestamp: "t" });
    expect(done[0].confirmationState).toBe("done");
    expect(done[1].actions).toBeUndefined();
    const httpError = applyConfirmationResult([cardMessage()], "a_offer", { responseOk: false, payload: { message: "انتهت الجلسة" }, id: "r", timestamp: "t" });
    expect(httpError[0].confirmationState).toBe("pending");
    // A success can never be turned into a refusal by the flag.
    const okFlag = applyConfirmationResult([cardMessage()], "a_offer", { responseOk: true, payload: { ok: true, reply: "تم", contained: true }, id: "r", timestamp: "t" });
    expect(okFlag[0].confirmationState).toBe("done");
  });
});

describe("the chat window, confirming a historical payment card", () => {
  const fetchMock = vi.fn();
  const props = { isOpen: true, onClose: () => {}, currentUserRole: "admin", currentUserName: "مدير اصطناعي" } as Parameters<typeof AiStaffChatModal>[0];
  const render = () => { hooks.cursor = 0; return nodes(AiStaffChatModal(props) as ReactNode); };
  beforeEach(() => {
    hooks.values = []; hooks.cursor = 0;
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => containedPayload() });
    render();
    hooks.values[0] = [cardMessage()]; // messages state: the card issued before containment, still on screen
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("shows a terminal refusal, the preserved card, the qualified wording and the /finance link — never a retry button", async () => {
    const confirm = render().find((node) => node.type === "button" && text(node).includes("تأكيد التنفيذ"));
    expect(confirm).toBeDefined();
    (confirm!.props.onClick as () => void)(); // the button fires the request without returning its promise
    await vi.waitFor(() => expect((hooks.values[0] as ChatMessage[])).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ token: historicalOffer.token });

    const tree = render();
    const all = tree.map(text).join(" ");
    expect(tree.some((node) => node.type === "button" && text(node).includes("تأكيد التنفيذ"))).toBe(false);
    expect(all).toContain("رُفض التنفيذ نهائيًا");
    for (const field of historicalOffer.fields) expect(all).toContain(field.value);
    for (const pattern of QUALIFIED) expect(all).toMatch(pattern);
    const link = tree.find((node) => node.type === "a" && node.props.href === "/finance");
    expect(link).toBeDefined();
    expect(text(link)).toContain("فتح شاشة التحصيل");
    // A second click is impossible and nothing else was sent.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
