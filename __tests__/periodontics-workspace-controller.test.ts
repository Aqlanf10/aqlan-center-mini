import { describe, expect, it, vi } from "vitest";
import { PeriodonticsWorkspaceController, workspacePending, type WorkspaceContext } from "../components/periodontics/workspace-controller";
import { PerioApiError, type PerioWorkspaceApi } from "../components/periodontics/api";
import { examFixture } from "./periodontics-workspace-fixtures";
import type { PerioExamView } from "../lib/periodontics-db";

const context = (): WorkspaceContext => ({ patientId: 1, currentVisit: { id: 11, patientId: 1, date: "2026-10-03", signedAt: null, caseId: null }, editable: true, contextStatus: "ready" });
function setup(changes: Partial<WorkspaceContext> = {}) {
  const list = vi.fn<PerioWorkspaceApi["list"]>().mockResolvedValue([examFixture()]);
  const save = vi.fn<PerioWorkspaceApi["save"]>().mockImplementation(async (_patient, _visit, body) => examFixture({ ...body, revision: 4 }));
  const addendum = vi.fn<PerioWorkspaceApi["addendum"]>().mockResolvedValue(examFixture({ signedAt: "2026-10-03T09:00:00Z", addenda: [{ id: 501, body: "Correction", author: "user", createdAt: "2026-10-03T10:00:00Z" }] }));
  const onPersisted = vi.fn(); const makeKey = vi.fn(() => "perio:stable-attempt");
  const ctx = { ...context(), ...changes };
  const controller = new PeriodonticsWorkspaceController(ctx, { list, save, addendum }, onPersisted, makeKey);
  return { controller, list, save, addendum, onPersisted, makeKey, ctx };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((res) => { resolve = res; }); return { promise, resolve }; }

describe("periodontal workspace request, draft and authority containment", () => {
  it("requires a successfully loaded explicit context and existing same-patient visit", async () => {
    for (const change of [{ contextStatus: "loading" as const }, { contextStatus: "error" as const }, { currentVisit: null }, { editable: false }, { currentVisit: { ...context().currentVisit!, patientId: 2 } }]) {
      const item = setup(change); await item.controller.load();
      item.controller.changeSite(11, "MB", { depthText: "9" }); await item.controller.save();
      expect(item.save).not.toHaveBeenCalled(); expect(workspacePending(item.controller.getSnapshot())).toBe(false);
    }
  });
  it("never treats failed history as an empty editable record", async () => {
    const item = setup(); item.list.mockRejectedValue(new PerioApiError("failed", 500));
    await item.controller.load(); item.controller.changeSite(11, "MB", { depthText: "9" }); await item.controller.save();
    expect(item.controller.getSnapshot().loaded).toBe(false); expect(item.save).not.toHaveBeenCalled();
  });
  it("uses actual selected doctor, explicit null case and exact initial null revision", async () => {
    const item = setup(); item.list.mockResolvedValue([]); await item.controller.load();
    item.controller.changeSite(55, "DL", { depthText: "٠", bleedingOnProbing: false });
    await item.controller.save(); expect(item.save).not.toHaveBeenCalled();
    item.controller.changeContext({ doctorId: 9, caseId: null }); await item.controller.save();
    expect(item.save).toHaveBeenCalledWith(1, 11, { doctorId: 9, caseId: null, expectedRevision: null, sites: [{ toothCode: 55, site: "DL", probingDepthMm: 0, bleedingOnProbing: false }] }, expect.any(AbortSignal));
  });
  it("sends complete retained snapshot with exact revision; only confirmed success clears dirty", async () => {
    const item = setup(); await item.controller.load(); item.controller.changeSite(11, "B", { bleedingOnProbing: false });
    const pending = deferred<PerioExamView>(); item.save.mockReturnValue(pending.promise);
    const work = item.controller.save();
    expect(item.controller.getSnapshot().busy).toBe("save"); expect(workspacePending(item.controller.getSnapshot())).toBe(true); expect(item.onPersisted).not.toHaveBeenCalled();
    expect(item.save.mock.calls[0][2]).toMatchObject({ expectedRevision: 3, doctorId: 7, caseId: null });
    expect(item.save.mock.calls[0][2].sites).toContainEqual(examFixture().sites[1]);
    pending.resolve(examFixture({ ...item.save.mock.calls[0][2], revision: 4 })); await work;
    expect(workspacePending(item.controller.getSnapshot())).toBe(false); expect(item.onPersisted).toHaveBeenCalledTimes(1);
  });
  it("guards duplicate submissions and edits while a mutation is in flight", async () => {
    const item = setup(); await item.controller.load(); item.controller.changeSite(11, "MB", { depthText: "5" });
    const pending = deferred<PerioExamView>(); item.save.mockReturnValue(pending.promise);
    const work = item.controller.save(); await item.controller.save(); item.controller.changeSite(11, "MB", { depthText: "7" });
    expect(item.save).toHaveBeenCalledTimes(1); expect(item.controller.getSnapshot().draft.sites[0].depthText).toBe("5");
    pending.resolve(examFixture({ revision: 4 })); await work;
  });
  it("history refresh preserves dirty text and requires explicit revision review", async () => {
    const item = setup(); await item.controller.load(); item.controller.changeSite(11, "MB", { depthText: "1.234" });
    item.list.mockResolvedValue([examFixture({ revision: 4 })]); await item.controller.load();
    expect(item.controller.getSnapshot().draft.sites[0].depthText).toBe("1.234");
    expect(item.controller.getSnapshot().draft.expectedRevision).toBe(3); expect(item.controller.getSnapshot().recovery).toBe("review");
    expect(item.controller.canEdit()).toBe(false);
    item.controller.useReviewedRevision(); expect(item.controller.getSnapshot().draft.expectedRevision).toBe(4);
    expect(workspacePending(item.controller.getSnapshot())).toBe(true);
  });
  it("a revision conflict retains local and canonical versions without automatic overwrite", async () => {
    const item = setup(); await item.controller.load(); item.controller.changeSite(11, "MB", { depthText: "4.5" });
    item.save.mockRejectedValue(new PerioApiError("conflict", 409, "revision_conflict")); item.list.mockResolvedValue([examFixture({ revision: 5 })]);
    await item.controller.save();
    expect(item.controller.getSnapshot().draft.sites[0].depthText).toBe("4.5"); expect(item.controller.getSnapshot().draft.expectedRevision).toBe(3);
    expect(item.controller.getSnapshot().exams[0].revision).toBe(5); expect(item.controller.getSnapshot().recovery).toBe("review");
    await item.controller.save(); expect(item.save).toHaveBeenCalledTimes(1);
    item.controller.useReviewedRevision(); expect(item.controller.getSnapshot().draft.expectedRevision).toBe(5);
    expect(item.onPersisted).not.toHaveBeenCalled();
  });
  it("reconciles uncertain saves only through an identical canonical snapshot", async () => {
    const item = setup(); await item.controller.load(); item.controller.changeSite(11, "MB", { depthText: "2.5" });
    item.save.mockRejectedValue(new PerioApiError("uncertain", 500));
    const saved = examFixture({ revision: 4, sites: [{ ...examFixture().sites[0], probingDepthMm: 2.5 }, examFixture().sites[1]] });
    item.list.mockResolvedValue([saved]); await item.controller.save();
    expect(item.list).toHaveBeenCalledTimes(2); expect(item.save).toHaveBeenCalledTimes(1); expect(item.onPersisted).toHaveBeenCalledWith(saved);
    expect(workspacePending(item.controller.getSnapshot())).toBe(false); expect(item.controller.getSnapshot().recovery).toBeNull();
  });
  it("failed reconciliation blocks retry and keeps draft until a canonical read succeeds", async () => {
    const item = setup(); await item.controller.load(); item.controller.changeSite(11, "MB", { depthText: "2.5" });
    item.save.mockRejectedValue(new PerioApiError("offline", null)); item.list.mockRejectedValue(new PerioApiError("offline", null));
    await item.controller.save(); await item.controller.save(); expect(item.save).toHaveBeenCalledTimes(1);
    expect(item.controller.getSnapshot().recovery).toBe("reload"); expect(workspacePending(item.controller.getSnapshot())).toBe(true);
    item.list.mockResolvedValue([examFixture()]); await item.controller.load(); expect(item.controller.getSnapshot().recovery).toBe("review");
  });
  it("same-patient visit/case/signature changes freeze the anchored dirty draft", async () => {
    for (const patch of [{ id: 12 }, { caseId: 50 }, { signedAt: "2026-10-03T10:00:00Z" }]) {
      const item = setup(); await item.controller.load(); item.controller.changeSite(11, "MB", { depthText: "4" });
      item.controller.setContext({ ...item.ctx, currentVisit: { ...item.ctx.currentVisit!, ...patch } });
      expect(item.controller.getSnapshot().anchorVisit?.id).toBe(11); expect(item.controller.getSnapshot().draft.expectedRevision).toBe(3);
      expect(item.controller.getSnapshot().staleContext).toBe(true); await item.controller.save(); expect(item.save).not.toHaveBeenCalled();
      expect(workspacePending(item.controller.getSnapshot())).toBe(true);
    }
  });
  it("clean context changes adopt existing visits without creating a visit or record", async () => {
    const item = setup(); await item.controller.load(); item.controller.setContext({ ...item.ctx, currentVisit: { ...item.ctx.currentVisit!, id: 12 } });
    expect(item.controller.getSnapshot().anchorVisit?.id).toBe(12); expect(item.controller.getSnapshot().draft.sites).toEqual([]);
    expect(item.controller.getSnapshot().draft.doctorId).toBeNull(); expect(item.save).not.toHaveBeenCalled();
  });
  it("preserves current draft across history selection and refuses history edits", async () => {
    const item = setup(); item.list.mockResolvedValue([examFixture(), examFixture({ id: 102, visitId: 12 })]); await item.controller.load();
    item.controller.changeSite(11, "MB", { depthText: "5" }); item.controller.select(102);
    item.controller.changeSite(11, "MB", { depthText: "9" }); await item.controller.save(); expect(item.save).not.toHaveBeenCalled();
    item.controller.select("current"); expect(item.controller.getSnapshot().draft.sites[0].depthText).toBe("5");
  });
  it("signed canonical records cannot be edited, rebased or replaced", async () => {
    const item = setup(); item.list.mockResolvedValue([examFixture({ signedAt: "2026-10-03T10:00:00Z" })]); await item.controller.load();
    item.controller.changeSite(11, "MB", { depthText: "5" }); await item.controller.save();
    expect(item.save).not.toHaveBeenCalled(); expect(item.controller.canEdit()).toBe(false);
  });
  it("an authority denial redacts prior clinical data instead of retaining the dirty snapshot", async () => {
    const item = setup(); await item.controller.load(); item.controller.changeSite(11, "MB", { depthText: "5" });
    item.save.mockRejectedValue(new PerioApiError("denied", 403)); await item.controller.save();
    expect(item.controller.getSnapshot().writeBlocked).toBe(true); expect(item.onPersisted).not.toHaveBeenCalled();
    expect(item.controller.getSnapshot().access).toBe("denied"); expect(item.controller.getSnapshot().exams).toEqual([]);
    expect(item.controller.getSnapshot().draft.sites).toEqual([]); expect(workspacePending(item.controller.getSnapshot())).toBe(false);
  });
  it("aborts requests and ignores stale completions after patient/authority unmount", async () => {
    const item = setup(); const pending = deferred<PerioExamView[]>(); item.list.mockReturnValue(pending.promise);
    const load = item.controller.load(); const signal = item.list.mock.calls[0][1]; item.controller.dispose();
    expect(signal.aborted).toBe(true); pending.resolve([examFixture()]); await load;
    expect(item.controller.getSnapshot().loaded).toBe(false); expect(item.controller.getSnapshot().exams).toEqual([]);
  });
  it("can restart after strict-mode effect cleanup without accepting the earlier request", async () => {
    const item = setup(); const first = deferred<PerioExamView[]>(); item.list.mockReturnValueOnce(first.promise);
    const oldLoad = item.controller.load(); item.controller.dispose(); item.controller.activate(); await item.controller.load();
    first.resolve([examFixture({ id: 777 })]); await oldLoad;
    expect(item.controller.getSnapshot().exams[0].id).toBe(101); expect(item.controller.getSnapshot().busy).toBeNull();
  });
});

describe("signed periodontal addenda are append-only and retry-stable", () => {
  it("reloads uncertain addenda and replays the exact key/text without inferring success from text", async () => {
    const item = setup(); const signed = examFixture({ signedAt: "2026-10-03T09:00:00Z" }); item.list.mockResolvedValue([signed]); await item.controller.load();
    item.controller.changeAddendum(101, "  Correction  ");
    item.addendum.mockRejectedValueOnce(new PerioApiError("unknown", 500));
    item.list.mockResolvedValue([{ ...signed, addenda: [{ id: 501, body: "Correction", author: "user", createdAt: "2026-10-03T10:00:00Z" }] }]);
    await item.controller.saveAddendum(101);
    expect(item.onPersisted).not.toHaveBeenCalled(); expect(workspacePending(item.controller.getSnapshot())).toBe(true);
    expect(item.controller.getSnapshot().addenda[101].needsReload).toBe(false);
    item.controller.changeAddendum(101, "Different"); expect(item.controller.getSnapshot().addenda[101].text).toBe("  Correction  ");
    await item.controller.saveAddendum(101);
    expect(item.makeKey).toHaveBeenCalledTimes(1); expect(item.addendum.mock.calls.map((call) => call[2])).toEqual([
      { text: "Correction", requestKey: "perio:stable-attempt" }, { text: "Correction", requestKey: "perio:stable-attempt" }]);
    expect(item.controller.getSnapshot().addenda[101]).toBeUndefined(); expect(item.onPersisted).toHaveBeenCalledTimes(1);
  });
  it("keeps the same request key blocked when reloading after uncertainty fails", async () => {
    const item = setup(); item.list.mockResolvedValue([examFixture({ signedAt: "2026-10-03T09:00:00Z" })]); await item.controller.load();
    item.controller.changeAddendum(101, "Correction"); item.addendum.mockRejectedValue(new PerioApiError("unknown", null)); item.list.mockRejectedValue(new Error("offline"));
    await item.controller.saveAddendum(101); await item.controller.saveAddendum(101);
    expect(item.addendum).toHaveBeenCalledTimes(1); expect(item.controller.getSnapshot().addenda[101]).toMatchObject({ requestKey: "perio:stable-attempt", needsReload: true });
  });
  it("does not regenerate a conflicting idempotency key", async () => {
    const item = setup(); item.list.mockResolvedValue([examFixture({ signedAt: "2026-10-03T09:00:00Z" })]); await item.controller.load();
    item.controller.changeAddendum(101, "Correction"); item.addendum.mockRejectedValue(new PerioApiError("conflict", 409, "idempotency_conflict"));
    await item.controller.saveAddendum(101); await item.controller.saveAddendum(101);
    expect(item.makeKey).toHaveBeenCalledTimes(1); expect(item.addendum).toHaveBeenCalledTimes(1); expect(item.controller.getSnapshot().addenda[101].blocked).toBe(true);
  });
  it("cannot add addenda to unsigned records or during a failed context read", async () => {
    const item = setup(); await item.controller.load(); item.controller.changeAddendum(101, "Correction"); await item.controller.saveAddendum(101);
    expect(item.addendum).not.toHaveBeenCalled(); expect(item.controller.getSnapshot().addenda).toEqual({});
  });
});


function expectRedacted(controller: PeriodonticsWorkspaceController, status: number) {
  const state = controller.getSnapshot();
  expect(state).toMatchObject({ access: status === 404 ? "unavailable" : "denied", loaded: false, busy: null,
    exams: [], addenda: {}, selected: "current", anchorVisit: null, recovery: null, writeBlocked: true });
  expect(state.draft).toEqual(state.baseline);
  expect(state.draft.sites).toEqual([]); expect(state.draft.doctorId).toBeNull(); expect(state.draft.expectedRevision).toBeNull();
  expect(state.error).toBeTruthy(); expect(state.notice).toBeNull();
  expect(workspacePending(state)).toBe(false); expect(controller.canEdit()).toBe(false);
}

describe("periodontal access denial redacts every clinical snapshot and fences requests", () => {
  it.each([401, 403, 404])("redacts history, pending observations and addenda on canonical GET %s", async (status) => {
    const item = setup(); const signed = examFixture({ id: 102, visitId: 12, signedAt: "2026-10-03T09:00:00Z" });
    item.list.mockResolvedValue([examFixture(), signed]); await item.controller.load();
    item.controller.changeSite(11, "MB", { depthText: "9.99" });
    item.controller.changeAddendum(102, "Private pending correction"); item.controller.select(102);
    item.list.mockRejectedValue(new PerioApiError("denied", status)); await item.controller.load();
    expectRedacted(item.controller, status); expect(item.list.mock.calls[1][1].aborted).toBe(true);
    const calls = item.list.mock.calls.length;
    item.list.mockResolvedValue([examFixture()]); item.controller.setContext(item.ctx); item.controller.adoptContext();
    item.controller.discardDraft(); item.controller.useReviewedRevision(); item.controller.select(102);
    item.controller.dispose(); item.controller.activate(); await item.controller.load();
    await item.controller.save(); await item.controller.saveAddendum(102);
    expect(item.list).toHaveBeenCalledTimes(calls); expect(item.save).not.toHaveBeenCalled(); expect(item.addendum).not.toHaveBeenCalled();
    expectRedacted(item.controller, status);
  });
  it.each([401, 403, 404])("redacts a direct PUT refusal %s", async (status) => {
    const item = setup(); await item.controller.load(); item.controller.changeSite(11, "MB", { depthText: "5" });
    item.save.mockRejectedValue(new PerioApiError("denied", status)); await item.controller.save();
    expectRedacted(item.controller, status); expect(item.onPersisted).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404])("redacts a direct addendum refusal %s including attempted text/key", async (status) => {
    const item = setup(); item.list.mockResolvedValue([examFixture({ signedAt: "2026-10-03T09:00:00Z" })]); await item.controller.load();
    item.controller.changeAddendum(101, "Private correction"); item.addendum.mockRejectedValue(new PerioApiError("denied", status));
    await item.controller.saveAddendum(101); expectRedacted(item.controller, status); expect(item.onPersisted).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404])("redacts rather than showing a generic failure when uncertain PUT reconciliation GET returns %s", async (status) => {
    const item = setup(); await item.controller.load(); item.controller.changeSite(11, "MB", { depthText: "5" });
    item.save.mockRejectedValue(new PerioApiError("uncertain", 500)); item.list.mockRejectedValue(new PerioApiError("denied", status));
    await item.controller.save(); expectRedacted(item.controller, status); expect(item.onPersisted).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404])("redacts uncertain addendum reconciliation GET %s without leaving a retryable private draft", async (status) => {
    const item = setup(); item.list.mockResolvedValue([examFixture({ signedAt: "2026-10-03T09:00:00Z" })]); await item.controller.load();
    item.controller.changeAddendum(101, "Private correction"); item.addendum.mockRejectedValue(new PerioApiError("uncertain", null));
    item.list.mockRejectedValue(new PerioApiError("denied", status)); await item.controller.saveAddendum(101);
    expectRedacted(item.controller, status); expect(item.onPersisted).not.toHaveBeenCalled();
  });
  it("a late older GET cannot restore history after a newer definitive denial", async () => {
    const item = setup(); const old = deferred<PerioExamView[]>(); item.list.mockReturnValueOnce(old.promise);
    const oldWork = item.controller.load(); item.controller.dispose(); item.controller.activate();
    item.list.mockRejectedValue(new PerioApiError("denied", 403)); await item.controller.load(); expectRedacted(item.controller, 403);
    old.resolve([examFixture()]); await oldWork; expectRedacted(item.controller, 403); expect(item.onPersisted).not.toHaveBeenCalled();
  });
  it("a late older PUT cannot restore data or publish a saved event after denial", async () => {
    const item = setup(); await item.controller.load(); item.controller.changeSite(11, "MB", { depthText: "5" });
    const old = deferred<PerioExamView>(); item.save.mockReturnValue(old.promise); const oldWork = item.controller.save();
    item.controller.dispose(); item.controller.activate(); item.list.mockRejectedValue(new PerioApiError("denied", 404));
    await item.controller.load(); old.resolve(examFixture({ revision: 4 })); await oldWork;
    expectRedacted(item.controller, 404); expect(item.onPersisted).not.toHaveBeenCalled();
  });
  it("a late older addendum cannot restore text or publish a saved event after denial", async () => {
    const item = setup(); item.list.mockResolvedValue([examFixture({ signedAt: "2026-10-03T09:00:00Z" })]); await item.controller.load();
    item.controller.changeAddendum(101, "Private correction"); const old = deferred<PerioExamView>(); item.addendum.mockReturnValue(old.promise);
    const oldWork = item.controller.saveAddendum(101); item.controller.dispose(); item.controller.activate();
    item.list.mockRejectedValue(new PerioApiError("denied", 401)); await item.controller.load();
    old.resolve(examFixture({ addenda: [{ id: 701, body: "Private correction", author: "user", createdAt: "2026-10-03T10:00:00Z" }] }));
    await oldWork; expectRedacted(item.controller, 401); expect(item.onPersisted).not.toHaveBeenCalled();
  });
  it("an old request's finally cannot clear a newer request's busy guard", async () => {
    const item = setup(); const old = deferred<PerioExamView[]>(); const next = deferred<PerioExamView[]>();
    item.list.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const oldWork = item.controller.load(); item.controller.dispose(); item.controller.activate(); const nextWork = item.controller.load();
    old.resolve([examFixture()]); await oldWork; expect(item.controller.getSnapshot().busy).toBe("load");
    expect(item.controller.getSnapshot().loaded).toBe(false);
    next.resolve([examFixture({ revision: 4 })]); await nextWork;
    expect(item.controller.getSnapshot().busy).toBeNull(); expect(item.controller.getSnapshot().exams[0].revision).toBe(4);
  });
  it.each([500, null])("transient read failure %s preserves the draft as stale and read-only until successful revalidation", async (status) => {
    const item = setup(); const signed = examFixture({ id: 102, visitId: 12, signedAt: "2026-10-03T09:00:00Z" });
    item.list.mockResolvedValue([examFixture(), signed]); await item.controller.load();
    item.controller.changeSite(11, "MB", { depthText: "5" }); item.controller.changeAddendum(102, "Pending correction");
    item.list.mockRejectedValue(new PerioApiError("temporarily unavailable", status)); await item.controller.load();
    expect(item.controller.getSnapshot().access).toBe("stale"); expect(item.controller.getSnapshot().loaded).toBe(true);
    expect(item.controller.getSnapshot().exams).toHaveLength(2); expect(workspacePending(item.controller.getSnapshot())).toBe(true);
    item.controller.changeSite(11, "MB", { depthText: "8" }); item.controller.changeAddendum(102, "Changed");
    await item.controller.save(); await item.controller.saveAddendum(102);
    expect(item.controller.getSnapshot().draft.sites[0].depthText).toBe("5");
    expect(item.controller.getSnapshot().addenda[102].text).toBe("Pending correction");
    expect(item.save).not.toHaveBeenCalled(); expect(item.addendum).not.toHaveBeenCalled();
    item.list.mockResolvedValue([examFixture(), signed]); await item.controller.load();
    expect(item.controller.getSnapshot().access).toBe("ready"); expect(item.controller.canEdit()).toBe(true);
    expect(item.controller.getSnapshot().draft.sites[0].depthText).toBe("5");
  });
});
