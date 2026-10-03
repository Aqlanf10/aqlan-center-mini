import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { patientContextAlerts } from "../lib/chair-readiness";
import { usePatientWorkspace } from "../components/patient-workspace/usePatientWorkspace";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(), pending: [] as Array<() => void> }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  return { ...react,
    useState: (initial: unknown) => { const index = slot(typeof initial === "function" ? initial() : initial); return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }]; },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useCallback: (callback: unknown, deps?: readonly unknown[]) => { const index = slot(undefined); const previous = hooks.memos.get(index); if (previous && same(previous.deps, deps)) return previous.value; hooks.memos.set(index, { deps, value: callback }); return callback; },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = slot(undefined); const previous = hooks.effects.get(index); if (previous && same(previous.deps, deps)) return; hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); }); },
  };
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const response = (body: unknown, status = 200) => ({ ok: status < 300, status, json: vi.fn(async () => body) });
const patient = { id: 91, patientNumber: "SYNTHETIC-91", fullName: "مريض تجريبي", medicalAlert: "old", phone: null };
const file = (alert = "old") => ({ patient: { ...patient, medicalAlert: alert }, visits: [], appointments: [] });
const summary = { planVisible: true, documentsVisible: true, activePlans: [], plannedVisits: [], counts: { visits: 0, openLabOrders: 0, documents: 0, orthoCase: false }, alerts: [], canSeeFinancial: true, financial: { balanceMinor: 999 } };
const detailedSummary = { ...summary, today: "2026-10-03",
  openVisit: { id: 21, status: "in_chair", chair: 1, arrivedAt: "2026-10-03T09:00:00Z", plannedTitle: "PRIVATE PLANNED TITLE" },
  activePlans: [{ id: 31, title: "PRIVATE PLAN", specialty: "endodontics", primaryDoctorName: "PLAN DOCTOR", consentAt: null,
    itemsCount: 2, doneItems: 1, totalMinor: 777777, doneMinor: 111111, remainingMinor: 666666, overdueMinor: 222222, nextDueDate: "2026-10-04" }],
  plannedVisits: [{ id: 41, title: "PRIVATE PLANNED VISIT" }],
  financial: { balanceMinor: 999, invoicedMinor: 1200, paidMinor: 201, openingMinor: 0,
    agreedMinor: 777777, treatmentDoneMinor: 111111, remainingTreatmentMinor: 666666, agreementPaidMinor: 222222, agreementRemainingMinor: 555555,
    byCurrency: { USD: { balanceMinor: 999, invoicedMinor: 1200, paidMinor: 201, openingMinor: 0,
      agreedMinor: 777777, treatmentDoneMinor: 111111, remainingTreatmentMinor: 666666, agreementPaidMinor: 222222, agreementRemainingMinor: 555555 } } },
  alerts: [{ kind: "overdue", severity: "danger", text: "PRIVATE MONEY ALERT" },
    { kind: "plan_blocked", severity: "warning", text: "PRIVATE PLAN ALERT" }, { kind: "lab_open", severity: "info", text: "CLINICAL ALERT" }],
};
let patientResponse: ReturnType<typeof response> | Promise<ReturnType<typeof response>>;
let workflowResponse: ReturnType<typeof response> | Promise<ReturnType<typeof response>>;
function ResourceProbe() { return usePatientWorkspace("91"); }
function render() { hooks.cursor = 0; const result = ResourceProbe(); hooks.pending.splice(0).forEach((effect) => effect()); return result; }
async function settle() { await vi.advanceTimersByTimeAsync(0); }
beforeEach(() => {
  vi.useFakeTimers(); hooks.values = []; hooks.cursor = 0; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  patientResponse = response(file()); workflowResponse = response(summary);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), setInterval, clearInterval });
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/workflow") ? workflowResponse : patientResponse));
});
afterEach(() => { hooks.effects.forEach((effect) => effect.cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("scoped patient workspace reads", () => {
  it("loads only the two canonical summary endpoints and keeps hook count stable", async () => {
    render(); const initialCount = hooks.cursor; await settle(); const ready = render();
    expect(hooks.cursor).toBe(initialCount); expect(ready.file?.patient.id).toBe(91); expect(ready.loading).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("revokes stale financial projection immediately when workflow refresh fails", async () => {
    render(); await settle(); expect(render().summary?.canSeeFinancial).toBe(true);
    workflowResponse = response({ message: "unavailable" }, 503); await render().reload();
    expect(render().summary).toBeNull(); expect(render().summaryError).toBe("unavailable");
    expect(render().file?.patient.id).toBe(91);
  });
  it("rejects another patient payload instead of rendering its identity", async () => {
    patientResponse = response({ ...file(), patient: { ...patient, id: 92 } });
    render(); await settle(); expect(render().file).toBeNull(); expect(render().error).toContain("غير مكتملة");
  });
  it("does not render stale records after access is revoked", async () => {
    render(); await settle(); patientResponse = response({ message: "denied" }, 403); await render().reload();
    expect(render().file).toBeNull(); expect(render().summary).toBeNull();
  });
  it.each([401, 403, 404])("revokes patient access on %s before either denial JSON or the workflow response settles", async (status) => {
    render(); await settle(); expect(render().summary?.canSeeFinancial).toBe(true);
    const unrelated = deferred<ReturnType<typeof response>>();
    const denied = response(null, status); denied.json.mockImplementation(() => new Promise(() => {}));
    patientResponse = denied; workflowResponse = unrelated.promise;
    await render().reload();
    expect(render().file).toBeNull(); expect(render().summary).toBeNull(); expect(render().loading).toBe(false);
    expect(render().error).toContain("غير متاح"); expect(denied.json).not.toHaveBeenCalled();
    const late = response(summary); unrelated.resolve(late); await settle();
    expect(late.json).not.toHaveBeenCalled(); expect(render().summary).toBeNull(); expect(render().file).toBeNull();
  });
  it.each([401, 403, 404])("revokes financial access on workflow %s while patient headers and denial JSON are pending", async (status) => {
    render(); await settle(); const unrelated = deferred<ReturnType<typeof response>>();
    const denied = response(null, status); denied.json.mockImplementation(() => new Promise(() => {}));
    workflowResponse = denied; patientResponse = unrelated.promise;
    const pending = render().reload(); await settle();
    expect(render().summary).toBeNull(); expect(render().summaryError).toContain("غير متاح");
    expect(render().file?.patient.id).toBe(91); expect(denied.json).not.toHaveBeenCalled();
    unrelated.resolve(response(file())); await pending;
    expect(render().summary).toBeNull(); expect(render().loading).toBe(false);
  });
  it("revokes workflow access without waiting for an already-started patient JSON body", async () => {
    render(); await settle(); const body = deferred<unknown>();
    const slowPatient = response(null); slowPatient.json.mockImplementation(() => body.promise);
    const headers = deferred<ReturnType<typeof response>>(); patientResponse = slowPatient; workflowResponse = headers.promise;
    const pending = render().reload(); await settle(); expect(slowPatient.json).toHaveBeenCalled();
    const denied = response(null, 403); headers.resolve(denied); await settle();
    expect(render().summary).toBeNull(); expect(denied.json).not.toHaveBeenCalled();
    body.resolve(file()); await pending; expect(render().summary).toBeNull();
  });
  it("fences a workflow JSON body already in flight when patient headers deny access", async () => {
    render(); await settle(); const body = deferred<unknown>();
    const slowWorkflow = response(null); slowWorkflow.json.mockImplementation(() => body.promise);
    const headers = deferred<ReturnType<typeof response>>(); patientResponse = headers.promise; workflowResponse = slowWorkflow;
    const pending = render().reload(); await settle(); expect(slowWorkflow.json).toHaveBeenCalled();
    headers.resolve(response(null, 401)); await pending;
    expect(render().file).toBeNull(); expect(render().summary).toBeNull();
    body.resolve(summary); await settle(); expect(render().summary).toBeNull(); expect(render().file).toBeNull();
  });
  it("cannot restore an older financial success after a newer workflow denial", async () => {
    render(); await settle(); const body = deferred<unknown>();
    const stale = response(null); stale.json.mockImplementation(() => body.promise); workflowResponse = stale;
    const old = render().reload(); await settle();
    workflowResponse = response(null, 403); await render().reload(); expect(render().summary).toBeNull();
    body.resolve(summary); await old; expect(render().summary).toBeNull();
  });
  it("ignores superseded denied headers rather than revoking a newer permitted read", async () => {
    render(); await settle(); const headers = deferred<ReturnType<typeof response>>(); patientResponse = headers.promise;
    const old = render().reload(); await settle();
    patientResponse = response(file("new verified")); await render().reload();
    const denied = response(null, 403); headers.resolve(denied); await old;
    expect(render().file?.patient.medicalAlert).toBe("new verified"); expect(render().summary?.canSeeFinancial).toBe(true);
    expect(denied.json).not.toHaveBeenCalled();
  });
  it.each(["headers", "body"])("narrows explicit workflow false capabilities while patient %s remain pending", async (stage) => {
    workflowResponse = response(detailedSummary); render(); await settle(); expect(render().summary?.planVisible).toBe(true);
    const headers = deferred<ReturnType<typeof response>>(); const body = deferred<unknown>();
    const slow = response(null); slow.json.mockImplementation(() => body.promise);
    patientResponse = stage === "headers" ? headers.promise : slow;
    workflowResponse = response({ ...detailedSummary, planVisible: false, canSeeFinancial: false });
    const pending = render().reload(); await settle();
    const denied = render().summary!;
    expect(denied).toMatchObject({ planVisible: false, canSeeFinancial: false, activePlans: [], plannedVisits: [], financial: null });
    expect(denied.openVisit).toMatchObject({ id: 21, status: "in_chair", plannedTitle: null });
    expect(denied.counts).toEqual(detailedSummary.counts); expect(denied.alerts.map((alert) => alert.text)).toEqual(["CLINICAL ALERT"]);
    expect(JSON.stringify(denied)).not.toMatch(/PRIVATE|777777|111111|666666|222222/);
    expect(render().file?.patient.id).toBe(91); expect(render().loading).toBe(true);
    if (stage === "headers") { expect(slow.json).not.toHaveBeenCalled(); headers.resolve(response(file())); } else body.resolve(file());
    await pending; expect(render().summary).toMatchObject({ planVisible: false, canSeeFinancial: false, activePlans: [], financial: null });
    expect(JSON.stringify(render().summary)).not.toMatch(/PRIVATE|777777|111111|666666|222222/);
  });
  it("removes plan amounts across currencies but preserves independently permitted balances on plan-only denial", async () => {
    workflowResponse = response(detailedSummary); render(); await settle();
    const headers = deferred<ReturnType<typeof response>>(); patientResponse = headers.promise;
    workflowResponse = response({ ...detailedSummary, planVisible: false });
    const pending = render().reload(); await settle(); const denied = render().summary!;
    expect(denied).toMatchObject({ planVisible: false, canSeeFinancial: true, activePlans: [], plannedVisits: [] });
    expect(denied.financial).toMatchObject({ balanceMinor: 999, agreedMinor: null, agreementPaidMinor: null,
      byCurrency: { USD: { balanceMinor: 999, agreedMinor: null, agreementRemainingMinor: null } } });
    expect(denied.openVisit?.id).toBe(21); expect(JSON.stringify(denied)).not.toMatch(/PRIVATE|777777|111111|666666|222222/);
    headers.resolve(response(file())); await pending;
  });
  it("retains clinical plan/visit identity while removing every cached financial projection on money-only denial", async () => {
    workflowResponse = response(detailedSummary); render(); await settle(); const visit = render().summary!.openVisit;
    const headers = deferred<ReturnType<typeof response>>(); patientResponse = headers.promise;
    workflowResponse = response({ ...detailedSummary, canSeeFinancial: false });
    const pending = render().reload(); await settle(); const denied = render().summary!;
    expect(denied.planVisible).toBe(true); expect(denied.canSeeFinancial).toBe(false); expect(denied.financial).toBeNull();
    expect(denied.openVisit).toBe(visit); expect(denied.activePlans[0]).toMatchObject({ id: 31, title: "PRIVATE PLAN", totalMinor: null,
      doneMinor: null, remainingMinor: null, overdueMinor: null, nextDueDate: null, financialVisible: false });
    expect(denied.alerts.map((alert) => alert.text)).toEqual(["PRIVATE PLAN ALERT", "CLINICAL ALERT"]);
    expect(JSON.stringify(denied)).not.toMatch(/PRIVATE MONEY ALERT|777777|111111|666666|222222/);
    headers.resolve(response(file())); await pending;
  });
  it.each(["initial", "denied"])("does not grant positive workflow capabilities before patient validation (%s)", async (prior) => {
    if (prior === "denied") { workflowResponse = response({ ...detailedSummary, planVisible: false, canSeeFinancial: false }); render(); await settle(); }
    const headers = deferred<ReturnType<typeof response>>(); patientResponse = headers.promise; workflowResponse = response(detailedSummary);
    const pending = prior === "initial" ? (render(), undefined) : render().reload(); await settle();
    expect(render().summary?.planVisible === true).toBe(false); expect(render().summary?.canSeeFinancial === true).toBe(false);
    headers.resolve(response(file())); if (pending) await pending; else await settle();
    expect(render().summary).toMatchObject({ planVisible: true, canSeeFinancial: true });
  });
  it("does not turn one explicit denial into a premature positive grant of the other capability", async () => {
    workflowResponse = response({ ...detailedSummary, planVisible: false, canSeeFinancial: false }); render(); await settle();
    const headers = deferred<ReturnType<typeof response>>(); patientResponse = headers.promise;
    workflowResponse = response({ ...detailedSummary, planVisible: false, canSeeFinancial: true });
    const pending = render().reload(); await settle();
    expect(render().summary).toMatchObject({ planVisible: false, canSeeFinancial: false, financial: null });
    headers.resolve(response({ ...file(), patient: { ...patient, id: 92 } })); await pending;
    expect(render().summary).toBeNull(); expect(render().file).toBeNull();
  });
  it("fences an old positive JSON body after a newer successful workflow explicitly revokes capabilities", async () => {
    workflowResponse = response(detailedSummary); render(); await settle();
    const oldBody = deferred<unknown>(); const oldWorkflow = response(null); oldWorkflow.json.mockImplementation(() => oldBody.promise);
    workflowResponse = oldWorkflow; const old = render().reload(); await settle();
    const headers = deferred<ReturnType<typeof response>>(); patientResponse = headers.promise;
    workflowResponse = response({ ...detailedSummary, planVisible: false, canSeeFinancial: false });
    const current = render().reload(); await settle(); expect(render().summary?.planVisible).toBe(false);
    oldBody.resolve(detailedSummary); await old;
    expect(render().summary).toMatchObject({ planVisible: false, canSeeFinancial: false, financial: null });
    headers.resolve(response(file())); await current;
    expect(render().summary).toMatchObject({ planVisible: false, canSeeFinancial: false, financial: null });
  });
  it("ignores superseded explicit denials instead of narrowing a newer accepted positive snapshot", async () => {
    workflowResponse = response(detailedSummary); render(); await settle();
    const oldBody = deferred<unknown>(); const oldWorkflow = response(null); oldWorkflow.json.mockImplementation(() => oldBody.promise);
    workflowResponse = oldWorkflow; const old = render().reload(); await settle();
    workflowResponse = response(detailedSummary); await render().reload();
    oldBody.resolve({ ...detailedSummary, planVisible: false, canSeeFinancial: false }); await old;
    expect(render().summary).toMatchObject({ planVisible: true, canSeeFinancial: true }); expect(render().summary?.financial?.balanceMinor).toBe(999);
  });
  it("settles loading when a confirmed medical save invalidates an older deferred read", async () => {
    render(); await settle(); const stale = deferred<ReturnType<typeof response>>(); patientResponse = stale.promise;
    const pending = render().reload(); expect(render().loading).toBe(true);
    render().confirmMedicalAlert("saved"); expect(render().loading).toBe(false);
    expect(render().confirmedAlert).toEqual({ revision: 1, value: "saved" });
    stale.resolve(response(file("old"))); await pending;
    expect(render().file?.patient.medicalAlert).toBe("saved");
  });
  it("clears denied financial payload even if an inconsistent response includes it", async () => {
    workflowResponse = response({ ...summary, canSeeFinancial: false });
    render(); await settle(); expect(render().summary?.financial).toBeNull();
  });
  it("keeps a successful identity save when an older read resolves afterward", async () => {
    render(); await settle(); const stale = deferred<ReturnType<typeof response>>(); patientResponse = stale.promise;
    const pending = render().reload(); const updated = { ...render().file!.patient, fullName: "اسم محفوظ جديد" };
    render().updatePatient(updated); stale.resolve(response(file())); await pending;
    expect(render().file?.patient.fullName).toBe("اسم محفوظ جديد"); expect(render().loading).toBe(false);
  });
  it("adopts later remote alert changes and removal without a today visit", async () => {
    render(); await settle(); render().confirmMedicalAlert("local saved");
    expect(patientContextAlerts(render().file!.patient.medicalAlert, null, render().confirmedAlert)).toEqual(["local saved"]);
    patientResponse = response(file("remote updated")); await render().reload();
    expect(render().confirmedAlert).toEqual({ revision: 2, value: "remote updated" });
    expect(patientContextAlerts(render().file!.patient.medicalAlert, null, render().confirmedAlert)).toEqual(["remote updated"]);
    patientResponse = response({ ...file(), patient: { ...patient, medicalAlert: null } }); await render().reload();
    expect(render().confirmedAlert).toEqual({ revision: 3, value: null });
    expect(patientContextAlerts(render().file!.patient.medicalAlert, null, render().confirmedAlert)).toEqual([]);
  });
  it("an accepted fresh patient read invalidates a previously started readiness revision", async () => {
    render(); await settle(); render().confirmMedicalAlert("local saved");
    const staleReadiness = { alerts: ["local saved", "history"], historyAlerts: ["history"], editableAlert: "local saved", confirmedAlertRevision: 1 };
    patientResponse = response(file("new remote alert")); await render().reload();
    expect(patientContextAlerts(render().file!.patient.medicalAlert, staleReadiness, render().confirmedAlert)).toEqual(["new remote alert", "history"]);
    const revision = render().confirmedAlert!.revision; await render().reload();
    expect(render().confirmedAlert!.revision).toBe(revision);
  });
  it("failed patient refresh preserves the confirmed warning", async () => {
    render(); await settle(); render().confirmMedicalAlert("saved warning");
    patientResponse = response({ message: "temporary failure" }, 503); await render().reload();
    expect(patientContextAlerts(render().file!.patient.medicalAlert, null, render().confirmedAlert)).toEqual(["saved warning"]);
  });

});

describe("patient-file appointment read visibility", () => {
  const appointment = { id: 301, doctorId: 7, scheduledDate: "2026-10-04", scheduledTime: "09:00", status: "booked" };
  const linkedVisit = { id: 201, patientId: 91, appointmentId: 301, note: "Synthetic clinical visit" };
  const calendarFile = (visibility: unknown) => ({ ...file(), appointmentVisibility: visibility, appointments: [appointment], visits: [linkedVisit] });

  it.each(["all", "scoped", "hidden", undefined, "invalid"])("projects the typed %s state without trusting a missing or invalid flag", async (visibility) => {
    patientResponse = response(calendarFile(visibility)); render(); await settle();
    const current = render().file!;
    const readable = visibility === "all" || visibility === "scoped";
    expect(current.appointmentVisibility).toBe(readable || visibility === "hidden" ? visibility : "unknown");
    expect(current.appointments).toEqual(readable ? [appointment] : []);
    expect(current.visits).toEqual([{ ...linkedVisit, appointmentId: readable ? 301 : null }]);
  });

  it("narrows accepted calendar metadata while the unrelated workflow read is still pending", async () => {
    patientResponse = response(calendarFile("all")); render(); await settle();
    expect(render().file?.appointments).toHaveLength(1);
    const pendingWorkflow = deferred<ReturnType<typeof response>>();
    workflowResponse = pendingWorkflow.promise; patientResponse = response(calendarFile("hidden"));
    const pending = render().reload(); await settle();
    expect(render().file).toMatchObject({ appointmentVisibility: "hidden", appointments: [], visits: [{ id: 201, appointmentId: null }] });
    pendingWorkflow.resolve(response(summary)); await pending;
  });

  it("cannot restore an older wide calendar response after a newer hidden response", async () => {
    patientResponse = response(calendarFile("all")); render(); await settle();
    const oldBody = deferred<unknown>(); const oldRead = response(null); oldRead.json.mockImplementation(() => oldBody.promise);
    patientResponse = oldRead; const old = render().reload(); await settle();
    patientResponse = response(calendarFile("hidden")); await render().reload();
    oldBody.resolve(calendarFile("all")); await old;
    expect(render().file).toMatchObject({ appointmentVisibility: "hidden", appointments: [], visits: [{ id: 201, appointmentId: null }] });
  });

  it("does not turn a calendar read flag into workflow write or financial capability", async () => {
    patientResponse = response(calendarFile("all"));
    workflowResponse = response({ ...summary, planVisible: false, canSeeFinancial: false });
    render(); await settle();
    expect(render().file?.appointmentVisibility).toBe("all");
    expect(render().summary).toMatchObject({ planVisible: false, canSeeFinancial: false, financial: null });
  });
});

describe("workflow calendar authority and refresh fencing", () => {
  beforeEach(() => { patientResponse = response({ ...file(), appointmentVisibility: "all" }); });
  const calendarSummary = (visibility: unknown) => ({ ...detailedSummary, appointmentVisibility: visibility,
    nextAppointment: { id: 991, date: "2026-11-12", time: "15:47", durationMinutes: 30, appointmentType: null, note: "CALENDAR_ONLY", status: "booked" },
    plannedVisits: [{ id: 41, planId: 31, title: "Clinical row", sequence: 1, planTitle: "Clinical plan", status: "scheduled",
      doctorName: null, durationMinutes: 30, note: "Clinical note", visitId: 51,
      appointmentId: 991, appointmentDate: "2026-11-12", appointmentTime: "15:47", appointmentVisibility: "all" }],
    alerts: [{ kind: "unscheduled_visit", severity: "warning", text: "BOOKING_ABSENCE" }, { kind: "plan_ready", severity: "info", text: "CLINICAL_READY" }],
  });
  it.each(["all", "scoped", "hidden", undefined, "bad"])("uses workflow %s authority independently of file-list authority", async (visibility) => {
    patientResponse = response({ ...file(), appointmentVisibility: "all" });
    workflowResponse = response(calendarSummary(visibility)); render(); await settle();
    const value = render().summary!; const readable = visibility === "all" || visibility === "scoped";
    expect(value.nextAppointment?.id ?? null).toBe(readable ? 991 : null);
    expect(value.plannedVisits[0].appointmentId).toBe(readable ? 991 : null);
    expect(value.alerts.some((alert) => alert.kind === "unscheduled_visit")).toBe(visibility === "all");
    expect(value.plannedVisits[0]).toMatchObject({ id: 41, planId: 31, visitId: 51, status: "scheduled", title: "Clinical row" });
  });
  it.each(["headers", "body"])("revokes calendar identities while peer patient %s remain pending", async (stage) => {
    workflowResponse = response(calendarSummary("all")); render(); await settle(); expect(render().summary?.nextAppointment?.id).toBe(991);
    const headers = deferred<ReturnType<typeof response>>(); const body = deferred<unknown>();
    const slow = response(null); slow.json.mockImplementation(() => body.promise);
    patientResponse = stage === "headers" ? headers.promise : slow;
    workflowResponse = response(calendarSummary("scoped"));
    const pending = render().reload(); await settle(); const narrowed = render().summary!;
    expect(narrowed).toMatchObject({ appointmentVisibility: "unknown", nextAppointment: null,
      plannedVisits: [{ id: 41, planId: 31, visitId: 51, status: "scheduled", appointmentId: null, appointmentDate: null, appointmentTime: null }] });
    expect(JSON.stringify(narrowed)).not.toMatch(/991|2026-11-12|15:47|CALENDAR_ONLY|BOOKING_ABSENCE/);
    expect(narrowed.alerts.map((alert) => alert.text)).toContain("CLINICAL_READY");
    if (stage === "headers") headers.resolve(response({ ...file(), appointmentVisibility: "all" })); else body.resolve({ ...file(), appointmentVisibility: "all" });
    await pending; expect(render().summary?.appointmentVisibility).toBe("scoped");
  });
  it("rechecks scoped identities even when the coarse visibility label has not changed", async () => {
    workflowResponse = response(calendarSummary("scoped")); render(); await settle();
    const headers = deferred<ReturnType<typeof response>>(); patientResponse = headers.promise;
    workflowResponse = response({ ...calendarSummary("scoped"), nextAppointment: null,
      plannedVisits: calendarSummary("all").plannedVisits.map((row) => ({ ...row, appointmentId: null, appointmentDate: null, appointmentTime: null, appointmentVisibility: "scoped" })) });
    const pending = render().reload(); await settle();
    expect(render().summary?.nextAppointment).toBeNull(); expect(render().summary?.plannedVisits[0].appointmentId).toBeNull();
    headers.resolve(response({ ...file(), appointmentVisibility: "all" })); await pending;
    expect(render().summary?.appointmentVisibility).toBe("scoped"); expect(render().summary?.nextAppointment).toBeNull();
  });
  it("cannot restore older calendar values after a newer hidden response", async () => {
    workflowResponse = response(calendarSummary("all")); render(); await settle();
    const oldBody = deferred<unknown>(); const oldRead = response(null); oldRead.json.mockImplementation(() => oldBody.promise);
    workflowResponse = oldRead; const old = render().reload(); await settle();
    workflowResponse = response(calendarSummary("hidden")); await render().reload();
    oldBody.resolve(calendarSummary("all")); await old;
    expect(render().summary).toMatchObject({ appointmentVisibility: "hidden", nextAppointment: null,
      plannedVisits: [{ id: 41, appointmentId: null, appointmentDate: null, appointmentTime: null }] });
  });
});

describe("peer calendar negative-only intersection", () => {
  const next = { id: 991, date: "2026-11-12", time: "15:47", durationMinutes: 30, appointmentType: null, note: "CALENDAR_ONLY", status: "booked" };
  const full = { ...detailedSummary, appointmentVisibility: "all", nextAppointment: next };
  it.each(["hidden", "scoped", "unknown"])("revokes cached workflow identities on accepted %s file read while workflow is pending", async (state) => {
    patientResponse = response({ ...file(), appointmentVisibility: "all" }); workflowResponse = response(full);
    render(); await settle(); expect(render().summary?.nextAppointment?.id).toBe(991);
    const pendingWorkflow = deferred<ReturnType<typeof response>>(); workflowResponse = pendingWorkflow.promise;
    patientResponse = response({ ...file(), appointmentVisibility: state });
    const pending = render().reload(); await settle();
    expect(render().summary?.nextAppointment).toBeNull();
    expect(render().summary?.appointmentVisibility).toBe(state === "hidden" ? "hidden" : "unknown");
    pendingWorkflow.resolve(response(full)); await pending;
    expect(render().summary?.nextAppointment).toBeNull();
    expect(render().summary?.appointmentVisibility).toBe(state === "hidden" ? "hidden" : "unknown");
  });
  it("revokes scoped -> scoped cached identities when the patient read arrives first", async () => {
    patientResponse = response({ ...file(), appointmentVisibility: "scoped" });
    workflowResponse = response({ ...full, appointmentVisibility: "scoped" });
    render(); await settle(); expect(render().summary?.nextAppointment?.id).toBe(991);
    const currentWorkflow = deferred<ReturnType<typeof response>>(); workflowResponse = currentWorkflow.promise;
    patientResponse = response({ ...file(), appointmentVisibility: "scoped", appointments: [] });
    const pending = render().reload(); await settle();
    expect(render().summary).toMatchObject({ appointmentVisibility: "unknown", nextAppointment: null });
    currentWorkflow.resolve(response({ ...full, appointmentVisibility: "scoped", nextAppointment: null })); await pending;
    expect(render().summary).toMatchObject({ appointmentVisibility: "scoped", nextAppointment: null });
  });
  it("fences a superseded wide patient body during a newer patient-first calendar revocation", async () => {
    patientResponse = response({ ...file(), appointmentVisibility: "all" }); workflowResponse = response(full);
    render(); await settle();
    const oldBody = deferred<unknown>(); const oldPatient = response(null); oldPatient.json.mockImplementation(() => oldBody.promise);
    patientResponse = oldPatient; const old = render().reload(); await settle();
    const currentWorkflow = deferred<ReturnType<typeof response>>(); workflowResponse = currentWorkflow.promise;
    patientResponse = response({ ...file(), appointmentVisibility: "hidden" });
    const current = render().reload(); await settle();
    expect(render().summary).toMatchObject({ appointmentVisibility: "hidden", nextAppointment: null });
    oldBody.resolve({ ...file(), appointmentVisibility: "all" }); await old;
    expect(render().summary).toMatchObject({ appointmentVisibility: "hidden", nextAppointment: null });
    currentWorkflow.resolve(response(full)); await current;
    expect(render().summary).toMatchObject({ appointmentVisibility: "hidden", nextAppointment: null });
  });
  it("does not promote a hidden workflow response using an all-visible peer file", async () => {
    patientResponse = response({ ...file(), appointmentVisibility: "all" });
    workflowResponse = response({ ...full, appointmentVisibility: "hidden" });
    render(); await settle();
    expect(render().summary).toMatchObject({ appointmentVisibility: "hidden", nextAppointment: null });
  });
});

describe("workflow document-count authority and existing refresh fences", () => {
  const documentsSummary = (visibility: unknown, count: unknown = 73519) => ({ ...detailedSummary,
    documentsVisible: visibility, counts: { ...detailedSummary.counts, documents: count } });

  it.each([false, undefined, null, "true", "unknown", 1])("never accepts a document count from %s workflow authority", async (visibility) => {
    workflowResponse = response(documentsSummary(visibility)); render(); await settle();
    expect(render().summary).toMatchObject({ documentsVisible: visibility === false ? false : null,
      counts: { ...detailedSummary.counts, documents: null } });
    expect(JSON.stringify(render().summary)).not.toContain("73519");
  });
  it.each([0, 73519])("preserves a confirmed document count of %s", async (count) => {
    workflowResponse = response(documentsSummary(true, count)); render(); await settle();
    expect(render().summary).toMatchObject({ documentsVisible: true, counts: { documents: count } });
  });
  it.each(["headers", "body"])("revokes a document count before peer patient %s settle", async (stage) => {
    workflowResponse = response(documentsSummary(true)); render(); await settle();
    expect(render().summary?.counts.documents).toBe(73519);
    const headers = deferred<ReturnType<typeof response>>(); const body = deferred<unknown>();
    const slow = response(null); slow.json.mockImplementation(() => body.promise);
    patientResponse = stage === "headers" ? headers.promise : slow;
    workflowResponse = response(documentsSummary(false));
    const pending = render().reload(); await settle();
    const current = render().summary!;
    expect(current).toMatchObject({ documentsVisible: false, counts: { ...detailedSummary.counts, documents: null },
      planVisible: true, canSeeFinancial: true });
    expect(current.openVisit).toEqual(detailedSummary.openVisit); expect(current.activePlans).toEqual(detailedSummary.activePlans);
    expect(current.financial).toEqual(detailedSummary.financial); expect(render().loading).toBe(true);
    expect(JSON.stringify(current)).not.toContain("73519");
    if (stage === "headers") headers.resolve(response(file())); else body.resolve(file());
    await pending;
    expect(render().summary).toMatchObject({ documentsVisible: false, counts: { documents: null } });
  });
  it.each(["missing-flag", "malformed-flag", "missing-count", "malformed-count"])("revokes a stale count on %s while patient JSON is pending", async (kind) => {
    workflowResponse = response(documentsSummary(true)); render(); await settle();
    const body = deferred<unknown>(); const slow = response(null); slow.json.mockImplementation(() => body.promise);
    patientResponse = slow;
    const next = documentsSummary(kind === "missing-flag" ? undefined : kind === "malformed-flag" ? "true" : true,
      kind === "malformed-count" ? "73519" : 73519);
    // Assign after helper defaults so this remains a genuinely missing count.
    if (kind === "missing-count") next.counts.documents = undefined;
    workflowResponse = response(next);
    const pending = render().reload(); await settle();
    expect(slow.json).toHaveBeenCalled(); expect(render().summary?.counts.documents).toBeNull();
    expect(JSON.stringify(render().summary)).not.toContain("73519");
    body.resolve(file()); await pending;
    expect(render().summary?.counts.documents).toBeNull();
  });
  it("does not restore an older positive document body after a newer denial with a delayed patient peer", async () => {
    workflowResponse = response(documentsSummary(true)); render(); await settle();
    const oldBody = deferred<unknown>(); const oldRead = response(null); oldRead.json.mockImplementation(() => oldBody.promise);
    workflowResponse = oldRead; const old = render().reload(); await settle();
    const patientHeaders = deferred<ReturnType<typeof response>>(); patientResponse = patientHeaders.promise;
    workflowResponse = response(documentsSummary(false)); const current = render().reload(); await settle();
    expect(render().summary?.counts.documents).toBeNull();
    oldBody.resolve(documentsSummary(true)); await old;
    expect(render().summary).toMatchObject({ documentsVisible: false, counts: { documents: null } });
    patientHeaders.resolve(response(file())); await current;
    expect(render().summary).toMatchObject({ documentsVisible: false, counts: { documents: null } });
  });
  it.each(["initial", "denied"])("does not publish a positive document grant before patient validation (%s)", async (prior) => {
    if (prior === "denied") { workflowResponse = response(documentsSummary(false)); render(); await settle(); }
    const headers = deferred<ReturnType<typeof response>>(); patientResponse = headers.promise;
    workflowResponse = response(documentsSummary(true));
    const pending = prior === "initial" ? (render(), undefined) : render().reload(); await settle();
    expect(render().summary?.documentsVisible === true).toBe(false);
    expect(render().summary?.counts.documents ?? null).toBeNull();
    headers.resolve(response(file())); if (pending) await pending; else await settle();
    expect(render().summary).toMatchObject({ documentsVisible: true, counts: { documents: 73519 } });
  });
  it("does not trust a positive peer field to authorize a legacy workflow count", async () => {
    patientResponse = response({ ...file(), documentsVisible: true });
    workflowResponse = response(documentsSummary(undefined)); render(); await settle();
    expect(render().summary).toMatchObject({ documentsVisible: null, counts: { documents: null } });
  });
  it("ignores an older denied document body after a newer confirmed count", async () => {
    workflowResponse = response(documentsSummary(true)); render(); await settle();
    const oldBody = deferred<unknown>(); const oldRead = response(null); oldRead.json.mockImplementation(() => oldBody.promise);
    workflowResponse = oldRead; const old = render().reload(); await settle();
    workflowResponse = response(documentsSummary(true, 0)); await render().reload();
    oldBody.resolve(documentsSummary(false)); await old;
    expect(render().summary).toMatchObject({ documentsVisible: true, counts: { documents: 0 } });
  });
});

describe("existing workspace read boundary for child timeline invalidation", () => {
  it("publishes readiness only after both current peers validate", async () => {
    const pending = deferred<ReturnType<typeof response>>(); workflowResponse = pending.promise;
    render(); await settle(); expect(render().readBoundary).toEqual({ revision: 1, ready: false });
    expect(render().file?.patient.id).toBe(91);
    pending.resolve(response(summary)); await settle(); expect(render().readBoundary).toEqual({ revision: 1, ready: true });
  });
  it("advances and revokes readiness immediately while refresh peers are pending", async () => {
    render(); await settle(); const first = render().readBoundary.revision;
    const pending = deferred<ReturnType<typeof response>>(); patientResponse = pending.promise;
    const reload = render().reload(); expect(render().readBoundary).toEqual({ revision: first + 1, ready: false });
    pending.resolve(response(file())); await reload; expect(render().readBoundary).toEqual({ revision: first + 1, ready: true });
  });
  it("does not turn a failed refresh into readiness merely because loading stops", async () => {
    render(); await settle(); workflowResponse = response(null, 403); await render().reload();
    expect(render().loading).toBe(false); expect(render().readBoundary.ready).toBe(false);
    expect(render().file).not.toBeNull();
  });
  it("does not let superseded peer bodies restore readiness after newer failure", async () => {
    render(); await settle(); const body = deferred<unknown>(); const old = response(null);
    old.json.mockImplementation(() => body.promise); workflowResponse = old;
    const stale = render().reload(); await settle(); workflowResponse = response(null, 403); await render().reload();
    const boundary = render().readBoundary; expect(boundary.ready).toBe(false);
    body.resolve(summary); await stale; expect(render().readBoundary).toEqual(boundary);
  });
  it.each(["patient", "medical"])("local %s save invalidation cannot certify stale peer authority", async (kind) => {
    render(); await settle(); const first = render().readBoundary.revision;
    if (kind === "patient") render().updatePatient(patient as never); else render().confirmMedicalAlert("new");
    expect(render().loading).toBe(false); expect(render().readBoundary).toEqual({ revision: first + 1, ready: false });
    await render().reload(); expect(render().readBoundary).toEqual({ revision: first + 2, ready: true });
  });
});
