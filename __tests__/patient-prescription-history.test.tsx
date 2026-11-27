import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canShowPrescriptionHistory, PatientPrescriptionHistory, usePatientPrescriptionHistory } from "../components/patient/PatientPrescriptionHistory";
import { patientDestination, patientLocationHref, readPatientLocation } from "../lib/patient-navigation";

type Harness = {
  state: unknown[]; memos: Map<number, { deps: readonly unknown[]; value: unknown }>;
  index: number; pending?: () => void; cleanup?: () => void;
};
const hooks = vi.hoisted(() => ({ h: null as Harness | null }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const active = () => {
    if (!hooks.h) throw new Error("Missing synthetic hook scope");
    return hooks.h;
  };
  const slot = (make: () => unknown, deps: readonly unknown[]) => {
    const h = active(), index = h.index++, slot = h.memos.get(index);
    if (slot && deps.length === slot.deps.length && deps.every((x, i) => Object.is(x, slot.deps[i]))) return slot.value;
    const value = make();
    h.memos.set(index, { deps, value });
    return value;
  };
  return { ...react, useId: () => "synthetic-heading",
    useMemo: slot,
    useState: (initial: unknown) => {
      const h = active(), index = h.index++;
      if (!(index in h.state)) h.state[index] = initial;
      return [h.state[index], (value: unknown) => { h.state[index] = typeof value === "function" ? value(h.state[index]) : value; }];
    },
    useEffect: (effect: () => (() => void) | undefined, deps: readonly unknown[]) => {
      const h = active();
      slot(() => { h.pending = () => { h.cleanup?.(); h.cleanup = effect(); }; }, deps);
    },
  };
});

const patient = 91001, other = 91002;
const fetcher = vi.fn<typeof fetch>();
const record = (id: number, status: "active" | "void" = "active", patientId = patient) => ({
  id, status, patientId, createdAt: "2031-01-04T22:30:00.000Z",
  items: [{ name: "SYN-MEDICATION-MUST-NOT-APPEAR-IN-LIST" }], diagnosis: "SYN-PRIVATE-DIAGNOSIS",
});
const response = (prescriptions: unknown, status = 200) => new Response(JSON.stringify({ prescriptions, suggestions: ["SYN-SUGGESTION"] }), { status });
const flush = () => new Promise<void>((done) => setTimeout(done, 0));

function scaffold() {
  return { state: [], index: 0, memos: new Map() } as Harness;
}
function ReadSyntheticHistory(h: Harness, id: number | null = patient, actor = "SYN-DOCTOR-A") {
  hooks.h = h;
  h.index = 0;
  const state = usePatientPrescriptionHistory(id, actor);
  hooks.h = null;
  const pending = h.pending;
  h.pending = undefined;
  pending?.();
  return state;
}
function tokens(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(tokens);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...tokens(el.props.children as ReactNode)];
}

beforeEach(() => { fetcher.mockReset(); vi.stubGlobal("fetch", fetcher); });
afterEach(() => vi.unstubAllGlobals());

describe("saved prescriptions (synthetic React output and GET data)", () => {
  it("uses an ordinary patient tab, keeps Files separate, and preserves existing tab/link semantics", () => {
    const before = readPatientLocation("?tab=summary&sub=endo");
    const destination = patientDestination("prescriptions", before);
    const href = patientLocationHref(`/patients/${patient}?origin=synthetic`, destination);
    expect(href).toBe(`/patients/${patient}?origin=synthetic&tab=prescriptions&sub=endo`);
    expect(readPatientLocation(new URL(href, "https://patient.invalid").search)).toEqual(destination);
    expect(patientDestination("files", before).tab).toBe("files");
    expect(canShowPrescriptionHistory("doctor")).toBe(true);
    expect(canShowPrescriptionHistory("admin")).toBe(true);
    expect([null, "reception", "assistant", "cashier", "accountant"].map(canShowPrescriptionHistory)).toEqual([false, false, false, false, false]);
  });

  it("uses one GET for Summary and full history, compact two latest and explicit active/void links", async () => {
    fetcher.mockResolvedValueOnce(response([record(92003), record(92002, "void"), record(92001)]));
    const h = scaffold();
    const openHistory = vi.fn();
    expect(renderToStaticMarkup(<PatientPrescriptionHistory patientId={patient} {...ReadSyntheticHistory(h)} openHistory={openHistory} />)).toContain("جارٍ تحميل");
    await flush();
    const compact = PatientPrescriptionHistory({ patientId: patient, ...ReadSyntheticHistory(h), openHistory });
    const compactHtml = renderToStaticMarkup(compact);
    const button = tokens(compact).find((el) => el.type === "button");
    expect(button?.props.children).toBe("عرض الوصفات المحفوظة");
    (button?.props.onClick as () => void)();
    expect(openHistory).toHaveBeenCalledOnce();
    expect(compactHtml).toContain("الوصفات الطبية");
    expect(compactHtml).toContain("92003");
    expect(compactHtml).toContain("92002");
    expect(compactHtml).not.toContain("92001");
    expect(compactHtml).not.toContain("/print/");
    const full = PatientPrescriptionHistory({ patientId: patient, ...ReadSyntheticHistory(h) });
    const fullHtml = renderToStaticMarkup(full);
    expect(fullHtml).toContain("سارية");
    expect(fullHtml).toContain("مُبطلة، لا تُصرف");
    expect(fullHtml).toContain("05/01/2031");
    expect(fullHtml).not.toContain("SYN-MEDICATION");
    expect(fullHtml).not.toContain("SYN-PRIVATE");
    expect(fullHtml).not.toContain("SYN-SUGGESTION");
    expect(tokens(full).filter((el) => el.type === "a").map((el) => el.props)).toMatchObject([
      { href: `/print/prescription/${patient}?rx=92003`, rel: "noopener noreferrer", target: "_blank", children: "فتح نسخة للطباعة" },
      { href: `/print/prescription/${patient}?rx=92002`, rel: "noopener noreferrer", target: "_blank", children: "عرض الوصفة المبطلة" },
      { href: `/print/prescription/${patient}?rx=92001`, rel: "noopener noreferrer", target: "_blank", children: "فتح نسخة للطباعة" },
    ]);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/patients/${patient}/prescriptions`, { method: "GET", cache: "no-store", signal: expect.any(AbortSignal) });
    h.cleanup?.();
  });

  it.each([
    { label: "different file", rows: [record(92001, "active", other)] },
    { label: "duplicate identity", rows: [record(92001), record(92001, "void")] },
  ])("shows recovery instead of print links for $label and handles a genuine empty list", async ({ rows }) => {
    fetcher.mockResolvedValueOnce(response(rows)).mockResolvedValueOnce(response([]));
    const h = scaffold();
    ReadSyntheticHistory(h);
    await flush();
    const failed = PatientPrescriptionHistory({ patientId: patient, ...ReadSyntheticHistory(h) });
    expect(renderToStaticMarkup(failed)).toContain("تعذّر تحميل");
    expect(renderToStaticMarkup(failed)).not.toContain("/print/prescription/");
    const button = tokens(failed).find((el) => el.type === "button");
    expect(button?.props.children).toBe("إعادة المحاولة");
    (button?.props.onClick as () => void)();
    expect(ReadSyntheticHistory(h).history.kind).toBe("loading");
    await flush();
    expect(renderToStaticMarkup(<PatientPrescriptionHistory patientId={patient} {...ReadSyntheticHistory(h)} />)).toContain("لا توجد روشتات محفوظة");
    h.cleanup?.();
  });

  it("retires an old chart and principal, leaves both surfaces without fetching, and reloads on reopen", async () => {
    let finish!: (value: Response) => void;
    fetcher.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(response([record(93001, "active", other)])).mockResolvedValueOnce(response([], 403));
    const h = scaffold();
    ReadSyntheticHistory(h);
    const oldSignal = fetcher.mock.calls[0][1]?.signal;
    ReadSyntheticHistory(h, null);
    expect(oldSignal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ReadSyntheticHistory(h, other, "SYN-DOCTOR-B").history.kind).toBe("loading");
    finish(response([record(92001)]));
    await flush();
    expect(renderToStaticMarkup(<PatientPrescriptionHistory patientId={other} {...ReadSyntheticHistory(h, other, "SYN-DOCTOR-B")} />)).toContain("rx=93001");
    ReadSyntheticHistory(h, null);
    expect(ReadSyntheticHistory(h).history.kind).toBe("loading");
    await flush();
    const denied = renderToStaticMarkup(<PatientPrescriptionHistory patientId={patient} {...ReadSyntheticHistory(h)} />);
    expect(denied).toContain("تعذّر الوصول");
    expect(denied).not.toContain("/print/prescription/");
    expect(fetcher).toHaveBeenCalledTimes(3);
    h.cleanup?.();
  });
});
