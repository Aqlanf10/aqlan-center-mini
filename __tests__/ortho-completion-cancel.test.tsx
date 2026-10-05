import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientOrtho, type AdjustmentForm } from "../components/PatientOrtho";

// Exercise PatientOrtho's real rendered button handlers with synthetic hook storage.
// Child editors are not executed; fetch and the native prompt are fully mocked.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false, context: null as unknown,
  memos: new Map<number, { value: unknown; deps?: readonly unknown[] }>(),
  effects: new Map<number, readonly unknown[] | undefined>(),
  pending: [] as (() => void)[],
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (compute: () => unknown, deps?: readonly unknown[]) => {
    const index = hooks.cursor++; const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = compute(); hooks.memos.set(index, { value, deps }); return value;
  };
  return { ...react,
    useContext: () => hooks.context,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[index], (update: unknown) => {
        const value = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(value, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = value;
      }];
    },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useLayoutEffect: (effect: () => void, deps?: readonly unknown[]) => {
      const index = hooks.cursor++;
      if (hooks.effects.has(index) && same(hooks.effects.get(index), deps)) return;
      hooks.effects.set(index, deps); hooks.pending.push(effect);
    },
    useEffect: (effect: () => void, deps?: readonly unknown[]) => {
      const index = hooks.cursor++;
      if (hooks.effects.has(index) && same(hooks.effects.get(index), deps)) return;
      hooks.effects.set(index, deps); hooks.pending.push(effect);
    },
  };
});
vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ username: "synthetic-doctor", role: "doctor", permissions: {} }),
}));
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic", useSetting: () => "" }));
vi.mock("../components/LegacyOnboardingChecklist", () => ({ LegacyOnboardingChecklist: () => null }));
vi.mock("../components/OrthoPackageLink", () => ({ OrthoPackageLink: () => null }));
vi.mock("../components/PatientCeph", () => ({ PatientCeph: () => null }));
vi.mock("../components/WebCephRecordsGrid", () => ({ WebCephRecordsGrid: () => null }));

type Case = ComponentProps<typeof AdjustmentForm>["caseRow"];
type Element = ReactElement<Record<string, unknown>>;
const PATIENT_ID = 19;
const CASE_ID = 41;
const COMPLETE_LABEL = "أُكملت الحالة بنجاح وسُلّم المثبت";
const DISCONTINUE_LABEL = "توقّفت الحالة";
const COMPLETE_PROMPT = "ملاحظة على إكمال الحالة (اختياري)";
const DISCONTINUE_PROMPT = "سبب التوقّف أو الإلغاء؟";
const fixture: Case = {
  id: CASE_ID, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null,
  status: "retention", phase: "retention", startDate: "2026-01-01", plannedMonths: 18,
  upperWire: null, lowerWire: null, planId: null, retainer: "essix", retainerOn: "2026-10-01", note: null,
  closedAt: null, closedBy: null, closedNote: null, baselineKind: null, baselineRecordedAt: null,
  elastics: null, responsibleDoctorName: null, legacyFinancialMode: null, remainingObjectives: null,
  adjustments: [],
  progress: { monthsElapsed: 9, monthsPlanned: 18, monthsRemaining: 9, percent: 50,
    overdue: false, adjustments: 0, lastAdjustment: null, daysSinceLast: null },
};
let caseRow: Case;
const prompt = vi.fn<() => string | null>();
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (node && typeof node === "object" && "props" in node) return text((node as Element).props.children as ReactNode);
  return "";
}
function render() {
  let tree: ReactNode = null; let rounds = 0;
  do {
    if (++rounds > 12) throw new Error("Synthetic render did not settle");
    hooks.cursor = 0; hooks.changed = false;
    const provider = PatientOrtho({ patientId: PATIENT_ID });
    hooks.context = provider.props.value;
    const workspace = provider.props.children as ReactElement<Record<string, unknown>>;
    tree = (workspace.type as (props: Record<string, unknown>) => ReactNode)(workspace.props);
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
function buttons(label: string) {
  return elements(render()).filter((node) => node.type === "button" && text(node).includes(label));
}
function button(label: string) {
  const matches = buttons(label); expect(matches).toHaveLength(1); return matches[0];
}
async function click(target: Element) { await (target.props.onClick as () => void | Promise<void>)(); }
async function settle() { for (let index = 0; index < 40; index++) await Promise.resolve(); }
async function openRetention(status: "active" | "retention") {
  caseRow = { ...fixture, status };
  render(); await settle();
  await click(button("التثبيت والاستبقاء"));
  expect(buttons(COMPLETE_LABEL)).toHaveLength(1);
  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
    [`/api/ortho?patientId=${PATIENT_ID}`, "GET"], [`/api/patients/${PATIENT_ID}`, "GET"],
  ]);
  fetchMock.mockClear();
}
function expectOneWrite(status: "completed" | "discontinued", note: string) {
  const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toEqual([`/api/ortho/${CASE_ID}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, note }),
  }]);
  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
    [`/api/ortho/${CASE_ID}`, "PATCH"], [`/api/ortho?patientId=${PATIENT_ID}`, "GET"], [`/api/patients/${PATIENT_ID}`, "GET"],
  ]);
  expect(buttons(COMPLETE_LABEL)).toHaveLength(0);
  expect(buttons(DISCONTINUE_LABEL)).toHaveLength(0);
}
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false;
  hooks.memos.clear(); hooks.effects.clear(); hooks.pending = [];
  caseRow = { ...fixture }; prompt.mockReset(); fetchMock.mockReset();
  fetchMock.mockImplementation(async (url, init) => {
    if (url === `/api/ortho/${CASE_ID}` && init?.method === "PATCH") {
      // Synthetic acknowledgement only; this test does not exercise server persistence.
      const body = JSON.parse(String(init.body)) as { status: Case["status"] };
      caseRow = { ...caseRow, status: body.status };
      return Response.json({ ok: true });
    }
    if (init?.method) throw new Error(`Unexpected synthetic write: ${url}`);
    if (url === `/api/ortho?patientId=${PATIENT_ID}`) return Response.json({ cases: [{ ...caseRow, patientId: PATIENT_ID }] });
    if (url === `/api/patients/${PATIENT_ID}`) return Response.json({ patient: { id: PATIENT_ID, fullName: "Synthetic patient", phone: null } });
    throw new Error(`Unexpected synthetic read: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("window", { prompt });
});
afterEach(async () => { await settle(); vi.unstubAllGlobals(); });

describe.each(["active", "retention"] as const)("PatientOrtho %s case completion prompt", (status) => {
  it("Cancel returns without a PATCH, reload, or local completion", async () => {
    await openRetention(status); prompt.mockReturnValue(null);
    await click(button(COMPLETE_LABEL)); await settle();
    expect(prompt).toHaveBeenCalledExactlyOnceWith(COMPLETE_PROMPT);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(buttons(COMPLETE_LABEL)).toHaveLength(1);
    expect(buttons(DISCONTINUE_LABEL)).toHaveLength(1);
    expect(caseRow.status).toBe(status);
  });

  it("accepting an empty optional note completes once and reloads", async () => {
    await openRetention(status); prompt.mockReturnValue("");
    await click(button(COMPLETE_LABEL));
    expect(prompt).toHaveBeenCalledExactlyOnceWith(COMPLETE_PROMPT);
    expectOneWrite("completed", "");
  });

  it.each(["  Synthetic completion note\nSecond line  ", "   "])("preserves the accepted note verbatim: %j", async (note) => {
    await openRetention(status); prompt.mockReturnValue(note);
    await click(button(COMPLETE_LABEL));
    expect(prompt).toHaveBeenCalledExactlyOnceWith(COMPLETE_PROMPT);
    expectOneWrite("completed", note);
  });

  it("a cancelled prompt can be reopened and explicitly accepted", async () => {
    await openRetention(status); prompt.mockReturnValueOnce(null).mockReturnValueOnce("");
    await click(button(COMPLETE_LABEL)); expect(fetchMock).not.toHaveBeenCalled();
    await click(button(COMPLETE_LABEL));
    expect(prompt).toHaveBeenCalledTimes(2); expectOneWrite("completed", "");
  });

  it.each([null, "", "  \n  "])("preserves discontinue's rejection of an absent or blank reason: %j", async (note) => {
    await openRetention(status); prompt.mockReturnValue(note);
    await click(button(DISCONTINUE_LABEL));
    expect(prompt).toHaveBeenCalledExactlyOnceWith(DISCONTINUE_PROMPT);
    expect(fetchMock).not.toHaveBeenCalled(); expect(caseRow.status).toBe(status);
    expect(buttons(COMPLETE_LABEL)).toHaveLength(1); expect(buttons(DISCONTINUE_LABEL)).toHaveLength(1);
  });

  it("preserves discontinue's nonblank reason and distinct status", async () => {
    const note = "  Synthetic discontinuation reason  ";
    await openRetention(status); prompt.mockReturnValue(note);
    await click(button(DISCONTINUE_LABEL));
    expect(prompt).toHaveBeenCalledExactlyOnceWith(DISCONTINUE_PROMPT);
    expectOneWrite("discontinued", note);
  });
});
