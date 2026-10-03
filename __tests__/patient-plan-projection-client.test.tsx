import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientPlans } from "../components/PatientPlans";
import { OrthoPackageLink } from "../components/OrthoPackageLink";
import { PatientLedger } from "../components/PatientLedger";
import { CollectPaymentModal } from "../components/CollectPaymentModal";
import { NO_PATIENT_PLAN_CAPABILITIES, patientPlanCapabilities, projectPatientPlan } from "../lib/patient-plan-projection";
import type { TreatmentPlan } from "../lib/db";

// Synthetic React-hook execution only: no browser, network, database, or real writes.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, changed: false,
  memo: new Map<number, { value: unknown; deps?: readonly unknown[] }>(),
  effects: new Map<number, readonly unknown[] | undefined>(), pending: [] as (() => void)[],
  session: { username: "synthetic", role: "doctor", permissions: { financeAccess: { collectPayments: false } } },
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const memo = (compute: () => unknown, deps?: readonly unknown[]) => {
    const index = hooks.cursor++; const previous = hooks.memo.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = compute(); hooks.memo.set(index, { value, deps }); return value;
  };
  return { ...react,
    useState: (initial: unknown) => { const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[index], (update: unknown) => { const next = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true; hooks.values[index] = next; }]; },
    useRef: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = { current: initial }; return hooks.values[index]; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void, deps?: readonly unknown[]) => { const index = hooks.cursor++;
      if (hooks.effects.has(index) && same(hooks.effects.get(index), deps)) return;
      hooks.effects.set(index, deps); hooks.pending.push(effect); },
    useLayoutEffect: (effect: () => void, deps?: readonly unknown[]) => { const index = hooks.cursor++;
      if (hooks.effects.has(index) && same(hooks.effects.get(index), deps)) return;
      hooks.effects.set(index, deps); hooks.pending.push(effect); },
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic", useSetting: () => "" }));
vi.mock("../components/CollectPaymentModal", () => ({ CollectPaymentModal: () => null }));
vi.mock("../lib/schedule", () => ({ clinicDateString: () => "2026-10-03" }));
vi.mock("../lib/reminders", () => ({ friendlyDateLong: (s: string) => s }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (node && typeof node === "object" && "props" in node) return text((node as Element).props.children as ReactNode);
  return "";
}
function resetHooks() { hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.memo.clear(); hooks.effects.clear(); hooks.pending = []; }
function render(component: () => ReactNode = () => PatientPlans({ patientId: 19 })) {
  let tree: ReactNode = null; let rounds = 0;
  do {
    if (++rounds > 12) throw new Error("Synthetic render did not settle");
    hooks.cursor = 0; hooks.changed = false; tree = component(); hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return { nodes: elements(tree), content: text(tree) };
}
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
const button = (nodes: Element[], label: string) => nodes.find((node) => node.type === "button" && text(node).includes(label));
const fixture = {
  id: 41, patientId: 19, patientName: "Synthetic", patientPhone: null, title: "خطة اختبار", totalMinor: 78000, paidMinor: 12000,
  baseCurrency: "USD", status: "active", startDate: "2026-01-01", note: null, createdAt: "2026-01-01", lastReminderAt: null,
  installments: [{ id: 1, number: 1, amountMinor: 39000, dueDate: "2026-11-23" }],
  progress: { totalMinor: 78000, dueToDateMinor: 39000, paidMinor: 12000, remainingMinor: 66000, overdueMinor: 27000,
    nextDueDate: "2026-11-23", nextDueAmountMinor: 39000, paidCount: 0, count: 2 },
  items: [{ id: 73, serviceId: 8, serviceName: "إجراء سريري", category: "rct", toothCode: 16, surfaces: "MO", quantity: 1,
    unitPriceMinor: 78000, totalMinor: 78000, status: "planned", visitId: null, doneAt: null, note: null,
    plannedVisitNumber: 2, sessionCount: 3, sessionsCompleted: 1, billingRule: "on_completion", billingStatus: "unbilled", doctorId: 7, doctorName: "Synthetic" }],
  itemsProgress: { count: 1, doneCount: 0, totalMinor: 78000, doneMinor: 0, remainingMinor: 78000 },
  totalFromItems: true, consentAt: null, consentBy: null, consentNote: null,
} as TreatmentPlan;
let payload: Record<string, unknown>;
const fetchMock = vi.fn();
beforeEach(() => {
  resetHooks(); hooks.session = { username: "synthetic", role: "doctor", permissions: { financeAccess: { collectPayments: false } } };
  payload = { plans: [projectPatientPlan(fixture, false)], canSeeFinancial: false, plannedVisits: [], baseCurrency: "YER",
    capabilities: patientPlanCapabilities("doctor", { canEditPlans: true, canViewServicePrices: false }, true) };
  fetchMock.mockReset(); fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method) throw new Error(`Unexpected synthetic write ${url}`);
    return { ok: true, json: async () => url.includes("ledger") ? { invoices: [], payments: [], plans: [], balance: { billedMinor: 0, collectedMinor: 0, openingMinor: 0, dueMinor: 0 }, baseCurrency: "YER" }
      : url.includes("plans") ? payload : [] };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => { await settle(); vi.unstubAllGlobals(); });

describe("PatientPlans least-authority controls", () => {
  it("defaults all controls off until the server capability read resolves", () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const view = render();
    expect(button(view.nodes, "قالب تخصص")).toBeUndefined();
    expect(button(view.nodes, "تحصيل")).toBeUndefined();
    expect(view.content).not.toContain("المتفق عليه");
  });
  it("retains money-hidden template and agreement creation and clinical grouping without fake zero prices", async () => {
    render(); await settle(); const view = render();
    expect(button(view.nodes, "قالب تخصص")).toBeDefined();
    expect(button(view.nodes, "مبلغ متفق")).toBeDefined();
    expect(button(view.nodes, "خطة سريعة")).toBeUndefined();
    expect(button(view.nodes, "خطة متقدمة")).toBeUndefined();
    expect(view.content).toContain("التفاصيل المالية غير متاحة");
    expect(view.content).toContain("اتفاق أقساط");
    const itemNode = view.nodes.find((node) => typeof node.type === "function" && node.type.name === "PlanItems")!;
    resetHooks(); const child = render(() => (itemNode.type as (props: unknown) => ReactNode)(itemNode.props));
    expect(child.content).toContain("إجراء سريري"); expect(child.content).toContain("16");
    expect(child.content).not.toContain("780");
    // Foreign-currency input labels remain legitimate write context; saved amounts do not.
    expect(child.nodes.find((node) => node.props["data-action"] === "plan-add-item")).toBeDefined();
    expect(child.nodes.find((node) => node.props["aria-label"] === "احذف إجراء سريري")).toBeDefined();
  });
  it("catalogue-only grant enables quick/manual creation without revealing saved agreement money", async () => {
    payload.capabilities = patientPlanCapabilities("doctor", { canEditPlans: true, canViewServicePrices: true }, true);
    render(); await settle(); const view = render();
    expect(button(view.nodes, "خطة سريعة")).toBeDefined(); expect(button(view.nodes, "خطة متقدمة")).toBeDefined();
    expect(view.content).toContain("التفاصيل المالية غير متاحة"); expect(view.content).not.toContain("المدفوع");
  });
  it("a finance-reading doctor has no collection, consent, completion or contract-print control", async () => {
    payload.plans = [projectPatientPlan(fixture, true)]; payload.canSeeFinancial = true;
    render(); await settle(); const view = render();
    expect(view.content).toContain("المدفوع");
    for (const label of ["تحصيل قسط", "إنهاء الخطة", "سجّل موافقة", "طباعة العقد"]) expect(view.content).not.toContain(label);
    expect(view.nodes.some((node) => typeof node.props.href === "string" && node.props.href.includes("/print/plan/"))).toBe(false);
  });
  it("canEditPlans false removes all creation/add/remove while retaining clinical reading", async () => {
    payload.capabilities = NO_PATIENT_PLAN_CAPABILITIES;
    render(); await settle(); const view = render(); expect(button(view.nodes, "قالب تخصص")).toBeUndefined();
    const itemNode = view.nodes.find((node) => typeof node.type === "function" && node.type.name === "PlanItems")!;
    resetHooks(); const child = render(() => (itemNode.type as (props: unknown) => ReactNode)(itemNode.props));
    expect(child.content).toContain("إجراء سريري");
    expect(child.nodes.some((node) => node.props["data-action"] === "plan-add-item")).toBe(false);
    expect(child.nodes.some((node) => String(node.props["aria-label"]).startsWith("احذف"))).toBe(false);
  });
  it.each(["admin", "reception"])("retains %s writer controls and reports failed completion without reloading as success", async (role) => {
    hooks.session.role = role; payload.canSeeFinancial = true; payload.plans = [projectPatientPlan(fixture, true)];
    payload.capabilities = patientPlanCapabilities(role, null);
    render(); await settle(); const view = render();
    expect(button(view.nodes, "تحصيل قسط")).toBeDefined(); expect(button(view.nodes, "سجّل موافقة")).toBeDefined();
    expect(view.content).toContain("طباعة العقد");
    const getCount = fetchMock.mock.calls.length;
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ message: "تعذّر إنهاء الخطة للاختبار" }) });
    await (button(view.nodes, "إنهاء الخطة")!.props.onClick as () => Promise<void>)();
    expect(render().content).toContain("تعذّر إنهاء الخطة للاختبار");
    expect(fetchMock.mock.calls.length).toBe(getCount + 1);
  });
});

it("ortho funding eligibility uses server metadata even when installments are hidden", async () => {
  const component = () => OrthoPackageLink({ caseId: 3, patientId: 19, planId: 41, canLink: true, onChanged: () => {} });
  render(component); await settle(); const view = render(component);
  expect(view.content).toContain("باقة تقويم"); expect(view.content).toContain("الشدّات مشمولة");
  expect(view.content).not.toContain("الخطة بلا أقساط");
});
it("ortho still offers the hidden-schedule agreement as a link target", async () => {
  const component = () => OrthoPackageLink({ caseId: 3, patientId: 19, planId: null, canLink: true, onChanged: () => {} });
  render(component); await settle(); const view = render(component);
  expect(view.nodes.find((node) => node.type === "option" && node.props.value === 41)).toBeDefined();
});

it.each(["doctor", "accountant", "assistant"])("ledger %s cannot acquire writers from finance visibility or generous props", async (role) => {
  hooks.session.role = role;
  const component = () => PatientLedger({ patientId: 19, capabilities: { canCreateInvoice: true, canCollectPayments: true } });
  render(component); await settle(); const view = render(component);
  expect(view.content).not.toContain("فاتورة يدوية"); expect(view.content).not.toContain("قبض دفعة");
  expect(view.nodes.find((node) => node.type === CollectPaymentModal)).toBeUndefined();
});
it.each(["admin", "reception"])("ledger preserves %s authorized writers", async (role) => {
  hooks.session.role = role; const component = () => PatientLedger({ patientId: 19 });
  render(component); await settle(); const view = render(component);
  expect(view.content).toContain("فاتورة يدوية"); expect(view.content).toContain("قبض دفعة");
  expect(view.nodes.find((node) => node.type === CollectPaymentModal)).toBeDefined();
});
it("ledger readOnly narrows admins and cashier collection limits remain separate", async () => {
  hooks.session.role = "admin"; const readOnly = () => PatientLedger({ patientId: 19, readOnly: true });
  render(readOnly); await settle(); let view = render(readOnly);
  expect(view.nodes.find((node) => node.type === CollectPaymentModal)).toBeUndefined();
  resetHooks(); hooks.session.role = "cashier"; const cashier = () => PatientLedger({ patientId: 19 });
  render(cashier); await settle(); view = render(cashier);
  expect(view.nodes.find((node) => node.type === CollectPaymentModal)).toBeUndefined();
  hooks.session.permissions.financeAccess.collectPayments = true; view = render(() => PatientLedger({ patientId: 19 }));
  expect(view.nodes.find((node) => node.type === CollectPaymentModal)).toBeDefined();
});
it("a rejected fresh permission read clears formerly visible plan data and capabilities", async () => {
  hooks.session.role = "admin"; payload.canSeeFinancial = true; payload.plans = [projectPatientPlan(fixture, true)];
  payload.capabilities = patientPlanCapabilities("admin", null);
  render(); await settle(); expect(render().content).toContain("المدفوع");
  hooks.session.role = "doctor";
  fetchMock.mockResolvedValue({ ok: false, json: async () => ({ message: "صلاحية الخطط مسحوبة" }) });
  let view = render(); expect(view.content).not.toContain("المدفوع");
  await settle(); view = render(); expect(view.content).toContain("صلاحية الخطط مسحوبة");
  expect(button(view.nodes, "قالب تخصص")).toBeUndefined(); expect(view.content).not.toContain("خطة اختبار");
});


const calendarVisit = { id: 65, planTitle: "Clinical plan distribution", sequence: 2, title: "Clinical planned row",
  doctorName: "Assigned clinician", durationMinutes: 45, status: "planned", note: "Clinical note",
  appointmentId: 991, appointmentDate: "2026-11-12", appointmentTime: "15:47", appointmentVisibility: "all" };
function calendarRow(view: ReturnType<typeof render>) {
  return view.nodes.find((node) => node.type === "li" && node.props["data-appointment-visibility"] !== undefined);
}

describe("PatientPlans planned-row calendar display", () => {
  it.each(["all", "scoped"])("renders a confirmed %s appointment without adding controls", async (appointmentVisibility) => {
    payload.appointmentVisibility = appointmentVisibility; payload.plannedVisits = [calendarVisit];
    payload.capabilities = NO_PATIENT_PLAN_CAPABILITIES;
    render(); await settle(); const view = render();
    expect(view.content).toContain("Clinical planned row"); expect(view.content).toContain("2026-11-12");
    expect(view.content).toContain("15:47"); expect(calendarRow(view)?.props["data-appointment-visibility"]).toBe(appointmentVisibility);
    expect(button(view.nodes, "جدول")).toBeUndefined(); expect(button(view.nodes, "قالب تخصص")).toBeUndefined();
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it.each([undefined, "unknown", "hidden"])("withholds stale dates when the response calendar is %s", async (appointmentVisibility) => {
    payload.appointmentVisibility = appointmentVisibility; payload.plannedVisits = [calendarVisit];
    render(); await settle(); const view = render();
    expect(view.content).toContain("Clinical planned row"); expect(view.content).not.toContain("2026-11-12");
    expect(view.content).not.toContain("15:47"); expect(view.content).not.toContain("لم يُحدد موعد");
    expect(view.content).not.toContain("تُجدوَل بتاريخ");
    expect(view.content).toContain(appointmentVisibility === "hidden" ? "محجوبة" : "غير مؤكدة");
  });

  it.each([undefined, "unknown", "hidden"])("withholds stale dates when the nested row is %s", async (appointmentVisibility) => {
    payload.appointmentVisibility = "all"; payload.plannedVisits = [{ ...calendarVisit, appointmentVisibility }];
    render(); await settle(); const view = render();
    expect(view.content).not.toContain("2026-11-12"); expect(view.content).not.toContain("15:47");
    expect(view.content).not.toContain("لم يُحدد موعد");
  });

  it.each(["planned", "scheduled", "in_progress"])("keeps a null scoped %s row clinically visible without claiming it is unbooked", async (status) => {
    payload.appointmentVisibility = "scoped"; payload.plannedVisits = [{ ...calendarVisit, status,
      appointmentId: null, appointmentDate: null, appointmentTime: null, appointmentVisibility: "scoped" }];
    render(); await settle(); const view = render();
    expect(view.content).toContain("Clinical planned row"); expect(view.content).toContain("قد يوجد حجز غير ظاهر");
    expect(view.content).not.toContain("لم يُحدد موعد"); expect(view.content).not.toContain("تُجدوَل بتاريخ");
  });

  it("distinguishes confirmed unscheduled work from a scheduled row without a visible reference", async () => {
    payload.appointmentVisibility = "all"; payload.plannedVisits = [{ ...calendarVisit,
      appointmentId: null, appointmentDate: null, appointmentTime: null }];
    render(); await settle(); let view = render(); expect(view.content).toContain("لم يُحدد موعد لهذه الزيارة");
    resetHooks(); payload.plannedVisits = [{ ...calendarVisit, status: "scheduled",
      appointmentId: null, appointmentDate: null, appointmentTime: null }];
    render(); await settle(); view = render(); expect(view.content).not.toContain("لم يُحدد موعد");
    expect(view.content).toContain("لا يظهر موعد مرتبط بهذه الزيارة");
  });

  it("does not display a partial legacy appointment as a booking", async () => {
    payload.appointmentVisibility = "all"; payload.plannedVisits = [{ ...calendarVisit, appointmentId: undefined }];
    render(); await settle(); const view = render();
    expect(view.content).not.toContain("2026-11-12"); expect(view.content).not.toContain("15:47");
    expect(calendarRow(view)?.props["data-appointment-visibility"]).toBe("unknown");
  });

  it("retires calendar certainty on a same-context refresh/error while retaining clinical data and existing draft owners", async () => {
    payload.appointmentVisibility = "all"; payload.plannedVisits = [calendarVisit];
    let focus: Parameters<typeof PatientPlans>[0]["focus"] = null;
    const component = () => PatientPlans({ patientId: 19, focus });
    render(component); await settle(); let view = render(component);
    expect(view.content).toContain("2026-11-12");
    (button(view.nodes, "مبلغ متفق")!.props.onClick as () => void)(); view = render(component);
    const form = view.nodes.find((node) => typeof node.type === "function" && node.type.name === "QuickAgreementPlanForm")!;
    expect(form).toBeDefined();
    let rejectRead!: (reason: unknown) => void;
    fetchMock.mockImplementation(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    focus = { kind: "plan_item", patientId: 19, planId: 41, itemId: 73 };
    view = render(component);
    expect(view.content).toContain("Clinical planned row"); expect(view.content).not.toContain("2026-11-12");
    expect(calendarRow(view)?.props["data-appointment-visibility"]).toBe("unknown");
    const pendingForm = view.nodes.find((node) => node.type === form.type)!;
    expect(pendingForm.key).toBe(form.key);
    rejectRead(new Error("Synthetic read failure")); await settle(); view = render(component);
    expect(view.content).toContain("Clinical planned row"); expect(view.content).toContain("غير مؤكدة");
    expect(view.content).not.toContain("2026-11-12");
    expect(view.nodes.find((node) => node.type === form.type)?.key).toBe(form.key);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it("does not carry an old patient's date into a pending newer patient read", async () => {
    payload.appointmentVisibility = "all"; payload.plannedVisits = [calendarVisit];
    render(); await settle(); expect(render().content).toContain("2026-11-12");
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const view = render(() => PatientPlans({ patientId: 20 }));
    expect(view.content).not.toContain("2026-11-12"); expect(view.content).not.toContain("Clinical planned row");
  });

  it("does not carry an old authority's date across a rejected session read", async () => {
    payload.appointmentVisibility = "all"; payload.plannedVisits = [calendarVisit];
    render(); await settle(); expect(render().content).toContain("2026-11-12");
    hooks.session.username = "different-synthetic-reader";
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ message: "Denied" }) });
    let view = render(); expect(view.content).not.toContain("2026-11-12");
    await settle(); view = render(); expect(view.content).not.toContain("Clinical planned row");
    expect(view.content).not.toContain("2026-11-12");
  });
});
