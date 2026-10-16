import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CONTRACT_SAVE_RECEIPT_TIMEOUT_MS, readBoundedContractSaveReceipt, createContractSaveAdmissionGate, confirmsContractSave, snapshotContractSave, type PendingContractSave } from "@/lib/hr-contract-save-receipt";

const intent = (): PendingContractSave => ({
  token: "synthetic-memory-intent", owner: "synthetic-admin\u0000admin", phase: "awaiting",
  method: "POST", path: "/api/hr/contracts", expectedId: null, expectedContractNumber: null, expectedStatus: "draft", expectedCreator: "synthetic-admin",
  payload: { staffId: "8", title: " Synthetic receipt ", templateKind: "doctor_hybrid", compensationKind: "salary_commission",
    startDate: "2026-10-11", endDate: null, probationEndDate: null, salaryCurrency: "SAR", salaryPeriod: "monthly",
    baseSalaryMinor: 12345, commissionRatePercent: 12.5, doctorPartyId: 4,
    termsPayload: { clauses: ["Synthetic explicit clause"], workingHoursPerWeek: null, hourlyRateMinor: null, extra: { a: 1, b: 2 } } },
});
const receipt = (request = intent()): Record<string, unknown> => ({
  ...request.payload, id: request.expectedId ?? 27, staffId: Number(request.payload.staffId), title: request.payload.title.trim(),
  status: request.expectedStatus, createdBy: request.expectedCreator, contractNumber: request.expectedContractNumber ?? `CTR-202610-${String(request.expectedId ?? 27).padStart(4, "0")}`,
  approvedAt: null, approvedBy: null, updatedAt: "2026-10-11T06:00:00.000Z",
});

describe("canonical contract save receipt", () => {
  it("requires the exact frozen create intent and full canonical receipt", () => {
    const source = intent(), saved = snapshotContractSave(source);
    source.payload.title = "Changed later";
    (source.payload.termsPayload.clauses as string[]).push("Not submitted");
    expect(saved.payload.title).toBe(" Synthetic receipt ");
    expect(saved.payload.termsPayload.clauses).toEqual(["Synthetic explicit clause"]);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.payload)).toBe(true);
    expect(Object.isFrozen(saved.payload.termsPayload.clauses)).toBe(true);
    expect(confirmsContractSave(receipt(saved), saved)).toBe(true);
    expect(confirmsContractSave(receipt(source), saved)).toBe(false);
  });

  it.each([
    ["id", 0], ["id", -1], ["id", "27"], ["id", null], ["id", NaN],
    ["staffId", 0], ["staffId", 9], ["staffId", "8"], ["title", "Another contract"],
    ["templateKind", "support_staff"], ["compensationKind", "salary"],
    ["startDate", "2026-10-12"], ["endDate", "2026-12-31"], ["probationEndDate", "2026-11-11"],
    ["salaryCurrency", "USD"], ["salaryPeriod", "weekly"], ["baseSalaryMinor", 12346],
    ["commissionRatePercent", 12.51], ["doctorPartyId", 5],
    ["status", "approved"], ["createdBy", "another-admin"], ["approvedBy", "someone"],
    ["approvedAt", "2026-10-11T06:00:00Z"], ["contractNumber", ""], ["updatedAt", "not-a-date"],
    ["termsPayload", {}], ["termsPayload", null],
  ])("rejects a mismatching %s witness", (field, value) => {
    const request = snapshotContractSave(intent());
    expect(confirmsContractSave({ ...receipt(request), [field as string]: value }, request)).toBe(false);
  });

  it("does not accept missing, scalar, empty, or partial acknowledgements", () => {
    const request = intent();
    for (const body of [null, undefined, true, 27, "ok", [], {}, { success: true }, { id: 27 }])
      expect(confirmsContractSave(body, request)).toBe(false);
  });

  it("keeps unknown pay distinct from explicit zero", () => {
    const unknown = intent();
    Object.assign(unknown.payload, { baseSalaryMinor: null, salaryCurrency: null, salaryPeriod: null, commissionRatePercent: null, doctorPartyId: null });
    expect(confirmsContractSave(receipt(unknown), unknown)).toBe(true);
    expect(confirmsContractSave({ ...receipt(unknown), baseSalaryMinor: 0 }, unknown)).toBe(false);
    const zero = intent();zero.payload.baseSalaryMinor = 0;zero.payload.commissionRatePercent = 0;
    expect(confirmsContractSave(receipt(zero), zero)).toBe(true);
    expect(confirmsContractSave({ ...receipt(zero), baseSalaryMinor: null }, zero)).toBe(false);
  });

  it("requires the exact PATCH target and unchanged draft context", () => {
    const request = intent();Object.assign(request, { method: "PATCH", path: "/api/hr/contracts/15", expectedId: 15, expectedContractNumber: "CTR-202512-0015", expectedStatus: "under_review", expectedCreator: "original-admin" });
    request.payload.expectedUpdatedAt = "2026-10-10T06:00:00.000Z";
    expect(confirmsContractSave(receipt(request), request)).toBe(true);
    expect(confirmsContractSave({ ...receipt(request), id: 16 }, request)).toBe(false);
    expect(confirmsContractSave({ ...receipt(request), contractNumber: "CTR-202610-0015" }, request)).toBe(false);
    expect(confirmsContractSave({ ...receipt(request), status: "draft" }, request)).toBe(false);
    expect(confirmsContractSave({ ...receipt(request), createdBy: "synthetic-admin" }, request)).toBe(false);
  });

  it("binds POST number to the allocated ID without guessing the server month", () => {
    const request = intent();
    expect(confirmsContractSave({ ...receipt(request), contractNumber: "CTR-202512-0027" }, request)).toBe(true);
    expect(confirmsContractSave({ ...receipt(request), id: 12345, contractNumber: "CTR-202701-12345" }, request)).toBe(true);
    for (const contractNumber of ["foreign", "CTR-202610-0028", "CTR-202610-27", "CTR-202610-00027", "CTR-202613-0027", "CTR-202600-0027", "CTR-202610-0027-A2", " CTR-202610-0027"])
      expect(confirmsContractSave({ ...receipt(request), contractNumber }, request)).toBe(false);
    const writer = readFileSync(new URL("../lib/hr-contracts-attendance.ts", import.meta.url), "utf8");
    expect(writer).toContain('allocated.toString().padStart(4, "0")');
    expect(writer).toContain('const contractNumber = `CTR-${datePrefix}-${nextSeq}`');
  });

  it("compares JSON objects without depending on PostgreSQL key order", () => {
    const request = intent(), body = receipt(request);
    body.termsPayload = { extra: { b: 2, a: 1 }, hourlyRateMinor: null, workingHoursPerWeek: null, clauses: ["Synthetic explicit clause"] };
    expect(confirmsContractSave(body, request)).toBe(true);
    expect(confirmsContractSave({ ...body, termsPayload: { ...(body.termsPayload as object), clauses: [] } }, request)).toBe(false);
  });

  it("binds native receipt validation and the pending lock to the production UI", () => {
    const source = readFileSync(new URL("../components/hr/ContractsPanel.tsx", import.meta.url), "utf8");
    const handler = source.slice(source.indexOf("const handleCreateContract"), source.indexOf("const handleTransitionStatus"));
    expect(handler).toContain("const lease = currentSaveAdmission();");
    expect(handler).toContain("if (!lease || activeSave.current || pendingSave || submitting) return;");
    expect(source).toContain("lease.detach()");
    expect(source).toContain("lease?.view === saveAdmission && lease.canAdmit()");
    expect(handler.indexOf("currentSaveAdmission()")).toBeLessThan(handler.indexOf("snapshotContractSave({"));
    expect(handler).toContain("expectedContractNumber: editingDraft?.contractNumber ?? null");
    expect(handler).toContain('newIdempotencyKey("hr-contract-intent")');
    expect(handler).not.toContain("crypto.randomUUID()");
    expect(handler.indexOf("onReserveSave(snapshot, lease)")).toBeLessThan(handler.indexOf("await fetch(submitted.path"));
    expect(CONTRACT_SAVE_RECEIPT_TIMEOUT_MS).toBe(12_000);
    expect(handler).toContain("await readBoundedContractSaveReceipt(async (signal)");
    expect(handler).toContain("JSON.stringify(submitted.payload), signal");
    const helper = readFileSync(new URL("../lib/hr-contract-save-receipt.ts", import.meta.url), "utf8");
    expect(helper).toContain("new AbortController()");
    expect(helper).toContain("controller.abort()");
    expect(helper).toContain("Promise.race([read(controller.signal), deadline])");
    expect(helper).toContain("clearTimeout(timer)");
    expect(handler.indexOf("await res.json()")).toBeLessThan(handler.indexOf("confirmsContractSave(receipt, request)"));
    expect(handler.indexOf("confirmsContractSave(receipt, request)")).toBeLessThan(handler.indexOf("onSettleSave(request.owner, request.token)"));
    expect(handler).toContain('phase: "uncertain"');
    const parent = readFileSync(new URL("../app/hr/page.tsx", import.meta.url), "utf8");
    expect(parent).toContain("contractSavesRef.current[owner]");
    expect(parent).toContain("current.token !== expectedToken");
    expect(parent).toContain("useLayoutEffect(() => saveAdmissionGate.commit(saveAdmission)");
    expect(parent).toContain("[owner, admin, tab]");
    expect(parent).toContain("if (!lease.canAdmit() || request.owner !== owner || contractSavesRef.current[owner]) return false;");
    const settlement = parent.slice(parent.indexOf("const settleContractSave"), parent.indexOf("  useEffect(() => {"));
    expect(settlement).not.toContain("canAdmit");
    expect(settlement).toContain("request.owner !== owner || request.token !== expectedToken");
    expect(handler).toContain("onSettleSave(request.owner, request.token) && lease.canAdmit()");
    expect(parent).toContain("<HrContractsPanel key={`${owner}:${staffId}:${contractId}`}");
    expect(parent).toContain("pendingSave={contractSaves[owner]}");
    expect(parent).toContain("Object.values(contractSaves).some(Boolean)");
    expect(parent).toContain('window.addEventListener("beforeunload"');
    expect(source).not.toContain("localStorage");expect(source).not.toContain("sessionStorage");
  });
});


describe("committed contract mutation admission", () => {
  const view = (owner = "admin-a", admin = true, contractsVisible = true) => Object.freeze({ owner, admin, contractsVisible });

  it("requires commit and current admin ownership before any reservation or dispatch", () => {
    const gate = createContractSaveAdmissionGate(), current = view(), lease = gate.mount(current);
    let reservations = 0, fetches = 0;
    const retainedHandler = () => { if (!lease.canAdmit()) return; reservations++;fetches++; };
    retainedHandler();expect([reservations, fetches]).toEqual([0, 0]);
    gate.commit(current);retainedHandler();expect([reservations, fetches]).toEqual([1, 1]);
    for (const blocked of [view("admin-a", false), view("", true), view("admin-a", true, false)]) {
      gate.commit(blocked);
      const blockedLease = gate.mount(blocked);
      expect(blockedLease.canAdmit()).toBe(false);
      retainedHandler();
    }
    expect([reservations, fetches]).toEqual([1, 1]);
  });

  it("rejects a retained A handler after A -> B -> A even when the owner string matches again", () => {
    const gate = createContractSaveAdmissionGate(), firstA = view();
    gate.commit(firstA);const firstLease = gate.mount(firstA);
    let reservations = 0, fetches = 0;
    const retainedHandler = () => { if (!firstLease.canAdmit()) return; reservations++;fetches++; };
    gate.commit(view("admin-b"));retainedHandler();
    const nextA = view();gate.commit(nextA);retainedHandler();
    expect([reservations, fetches]).toEqual([0, 0]);
    expect(gate.mount(nextA).canAdmit()).toBe(true);
  });

  it("revokes a detached panel permanently and requires a new committed generation on tab return", () => {
    const gate = createContractSaveAdmissionGate(), first = view();
    const cleanupFirst = gate.commit(first), lease = gate.mount(first);
    let reservations = 0, fetches = 0;
    const retainedHandler = () => { if (!lease.canAdmit()) return; reservations++;fetches++; };
    lease.detach();retainedHandler();
    gate.commit(view("admin-a", true, false));retainedHandler();
    const reopened = view();gate.commit(reopened);const nextLease = gate.mount(reopened);
    cleanupFirst();retainedHandler();
    expect([reservations, fetches]).toEqual([0, 0]);
    expect(nextLease.canAdmit()).toBe(true);
    const cleanupReopened = gate.commit(reopened);cleanupReopened();
    expect(nextLease.canAdmit()).toBe(false);
  });
});


describe("bounded native contract receipt", () => {
  it("aborts a stalled body and cannot report success if that body resolves after the deadline", async () => {
    vi.useFakeTimers();
    try {
      const original = snapshotContractSave(intent());
      let pending: PendingContractSave | undefined = original;
      let phase = "awaiting", releases = 0;
      let bodyResolve!: (body: unknown) => void;
      let readSignal: AbortSignal | undefined;
      const body = new Promise<unknown>(resolve => { bodyResolve = resolve; });
      const completion = readBoundedContractSaveReceipt(async signal => {
        readSignal = signal;
        // Model headers received, with body completion ignoring abort so that
        // the losing promise can still resolve after the runtime deadline.
        const receipt = await body;
        return { status: 201, receipt };
      }).then(({ receipt }) => {
        if (confirmsContractSave(receipt, original)) { pending = undefined;phase = "confirmed";releases++; }
      }, () => { pending = snapshotContractSave({ ...original, phase: "uncertain" });phase = "uncertain"; });
      await vi.advanceTimersByTimeAsync(CONTRACT_SAVE_RECEIPT_TIMEOUT_MS);
      await completion;
      expect(readSignal?.aborted).toBe(true);
      expect(phase).toBe("uncertain");
      expect(pending?.token).toBe(original.token);
      expect(pending?.payload).toEqual(original.payload);
      bodyResolve(receipt(original));
      await Promise.resolve();await Promise.resolve();
      expect(releases).toBe(0);
      expect(phase).toBe("uncertain");
      expect(pending?.token).toBe(original.token);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
