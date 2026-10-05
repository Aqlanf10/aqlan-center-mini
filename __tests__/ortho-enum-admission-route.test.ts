import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrthoCase } from "@/lib/db";
import { PHASE_LABEL, RETAINER_LABEL } from "@/lib/ortho";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";

vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: vi.fn() }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", getOrthoCase: vi.fn(), findUserByUsername: vi.fn(),
  setOrthoPhase: vi.fn(), setRetainer: vi.fn(), recordAdjustment: vi.fn(),
  closeOrthoCase: vi.fn(), linkOrthoCasePlan: vi.fn(),
}));

import { PATCH, POST } from "@/app/api/ortho/[id]/route";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import {
  getOrthoCase, setOrthoPhase, setRetainer, recordAdjustment, closeOrthoCase, linkOrthoCasePlan,
} from "@/lib/db";

const handlers = { PATCH, POST };
type Method = keyof typeof handlers;
const writers = [setOrthoPhase, setRetainer, recordAdjustment, closeOrthoCase, linkOrthoCasePlan];
const inherited = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"];
const otherUnknown = ["", "unknown", "ESSIX", " working "];
const nonstrings: unknown[] = [undefined, null, false, 0, 3, [], {}, { value: "working" }];
const context = (id = "41") => ({ params: Promise.resolve({ id }) });
const found = { id: 41, patientId: 101, status: "active" } as OrthoCase;
const request = (method: Method, body: unknown) => new Request("https://synthetic.invalid/api/ortho/41", {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const call = (method: Method, body: unknown) => handlers[method](request(method, body), context());
function noWriters() { for (const writer of writers) expect(writer).not.toHaveBeenCalled(); }
function onlyWriter(expected: (typeof writers)[number]) {
  expect(expected).toHaveBeenCalledTimes(1);
  for (const writer of writers) if (writer !== expected) expect(writer).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSession).mockResolvedValue({
    userId: 7, username: "synthetic-admin", role: "admin", expiresAt: 4_102_444_800_000,
  });
  vi.mocked(getOrthoCase).mockResolvedValue(found);
  vi.mocked(canAccessPatient).mockResolvedValue(true);
  vi.mocked(setOrthoPhase).mockResolvedValue(true);
  vi.mocked(setRetainer).mockResolvedValue(true);
  vi.mocked(recordAdjustment).mockResolvedValue({
    ok: true, id: 501, created: true, visitId: null, attachedToToday: false,
  });
  vi.mocked(closeOrthoCase).mockResolvedValue({ ok: true });
  vi.mocked(linkOrthoCasePlan).mockResolvedValue({ ok: true, changed: true, funded: true });
});

describe("actual PATCH retainer own-key admission", () => {
  it.each(Object.keys(RETAINER_LABEL))("accepts canonical retainer %s", async (retainer) => {
    const response = await call("PATCH", { retainer, retainerOn: "2026-09-21" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(setRetainer).toHaveBeenCalledWith({
      id: 41, retainer, deliveredOn: retainer === "none" ? null : "2026-09-21",
      preserveExistingDeliveryDate: false,
    });
    onlyWriter(setRetainer);
  });

  it.each([...inherited, ...otherUnknown])("rejects non-own retainer %j before every writer", async (retainer) => {
    const response = await call("PATCH", { retainer, status: "completed" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "نوع مثبّت غير معروف." });
    noWriters();
  });

  it.each(nonstrings.map((value) => [value] as const))("keeps non-string retainer %j outside the retainer branch", async (retainer) => {
    const response = await call("PATCH", { retainer });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "إجراء غير معروف." });
    noWriters();
  });

  it.each(nonstrings.map((value) => [value] as const))("keeps status fallthrough for non-string retainer %j", async (retainer) => {
    expect((await call("PATCH", { retainer, status: "completed" })).status).toBe(200);
    expect(closeOrthoCase).toHaveBeenCalledWith({
      id: 41, status: "completed", actor: "synthetic-admin", note: null,
    });
    onlyWriter(closeOrthoCase);
  });

  it("keeps explicit none without a delivery date", async () => {
    expect((await call("PATCH", { retainer: "none" })).status).toBe(200);
    expect(setRetainer).toHaveBeenCalledWith({ id: 41, retainer: "none", deliveredOn: null, preserveExistingDeliveryDate: true });
  });
});

describe("actual PATCH phase own-key admission", () => {
  it.each(Object.keys(PHASE_LABEL))("accepts canonical phase %s", async (phase) => {
    expect((await call("PATCH", { phase })).status).toBe(200);
    expect(setOrthoPhase).toHaveBeenCalledWith(41, phase);
    onlyWriter(setOrthoPhase);
  });

  it.each([...inherited, ...otherUnknown])("rejects non-own phase %j before every writer", async (phase) => {
    const response = await call("PATCH", { phase, retainer: "essix", status: "completed" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "مرحلة غير معروفة." });
    noWriters();
  });

  it.each(nonstrings.map((value) => [value] as const))("keeps non-string phase %j outside the phase branch", async (phase) => {
    const response = await call("PATCH", { phase });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "إجراء غير معروف." });
    noWriters();
  });

  it.each(nonstrings.map((value) => [value] as const))("keeps retainer fallthrough for non-string phase %j", async (phase) => {
    expect((await call("PATCH", { phase, retainer: "none" })).status).toBe(200);
    expect(setRetainer).toHaveBeenCalledWith({ id: 41, retainer: "none", deliveredOn: null, preserveExistingDeliveryDate: true });
    onlyWriter(setRetainer);
  });
});

describe("actual POST phase own-key normalization", () => {
  // POST's established unknown-phase contract is null, not request rejection.
  it.each(Object.keys(PHASE_LABEL))("passes canonical phase %s to the adjustment writer", async (phase) => {
    expect((await call("POST", { phase, nextWeeks: 5, done: "Synthetic adjustment" })).status).toBe(201);
    expect(recordAdjustment).toHaveBeenCalledWith(expect.objectContaining({
      caseId: 41, phase, nextWeeks: 5, done: "Synthetic adjustment",
      recordedBy: "synthetic-admin", actorRole: "admin",
    }));
    onlyWriter(recordAdjustment);
  });

  it.each([...inherited, ...otherUnknown, ...nonstrings].map((value) => [value] as const))("normalizes non-own phase %j to null while retaining valid adjustment data", async (phase) => {
    const response = await call("POST", {
      phase, nextWeeks: 5, doneOn: "2026-09-21", done: "Synthetic adjustment",
      upperWire: "014 NiTi", lowerWire: "012 NiTi", elastics: "class_ii", note: "Synthetic note",
    });
    expect(response.status).toBe(201);
    expect(recordAdjustment).toHaveBeenCalledWith({
      caseId: 41, visitId: null, doneOn: "2026-09-21", phase: null,
      upperWire: "014 NiTi", lowerWire: "012 NiTi", elastics: "class_ii", elasticNote: null,
      done: "Synthetic adjustment", nextWeeks: 5, note: "Synthetic note",
      recordedBy: "synthetic-admin", actorRole: "admin",
    });
    onlyWriter(recordAdjustment);
  });

  it("retains nextWeeks validation precedence for an inherited phase", async () => {
    const response = await call("POST", { phase: "constructor", nextWeeks: 53 });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "المدة حتى الشدّة القادمة بين أسبوع و52 أسبوعًا." });
    noWriters();
  });
});

describe("PATCH action precedence stays unchanged", () => {
  it("planId still wins over inherited phase and retainer strings", async () => {
    expect((await call("PATCH", { planId: null, phase: "constructor", retainer: "__proto__", status: "completed" })).status).toBe(200);
    expect(linkOrthoCasePlan).toHaveBeenCalledWith({
      caseId: 41, planId: null, actor: "synthetic-admin", actorRole: "admin",
    });
    onlyWriter(linkOrthoCasePlan);
  });
  it("valid phase still wins over inherited retainer and completion", async () => {
    expect((await call("PATCH", { phase: "working", retainer: "constructor", status: "completed" })).status).toBe(200);
    onlyWriter(setOrthoPhase);
  });
  it("valid retainer still wins over completion", async () => {
    expect((await call("PATCH", { retainer: "none", status: "completed" })).status).toBe(200);
    onlyWriter(setRetainer);
  });
});

describe.each(["PATCH", "POST"] as const)("%s guard precedence", (method) => {
  const invalidEnum = { phase: "constructor", retainer: "__proto__" };
  it("requires a session before reads or writes", async () => {
    vi.mocked(requireSession).mockResolvedValue(null);
    expect((await call(method, invalidEnum)).status).toBe(401);
    expect(getOrthoCase).not.toHaveBeenCalled();
    expect(canAccessPatient).not.toHaveBeenCalled();
    noWriters();
  });
  it("rejects an invalid case ID before case lookup", async () => {
    expect((await handlers[method](request(method, invalidEnum), context("0"))).status).toBe(400);
    expect(getOrthoCase).not.toHaveBeenCalled();
    noWriters();
  });
  it("returns not-found before body admission", async () => {
    vi.mocked(getOrthoCase).mockResolvedValue(null);
    expect((await call(method, invalidEnum)).status).toBe(404);
    expect(canAccessPatient).not.toHaveBeenCalled();
    noWriters();
  });
  it("keeps canonical patient denial ahead of enum admission", async () => {
    vi.mocked(canAccessPatient).mockResolvedValue(false);
    expect((await call(method, invalidEnum)).status).toBe(403);
    expect(canAccessPatient).toHaveBeenCalledWith(expect.objectContaining({ username: "synthetic-admin" }), 101);
    noWriters();
  });
  it("retains malformed JSON rejection", async () => {
    const malformed = new Request("https://synthetic.invalid/api/ortho/41", { method, body: "{" });
    expect((await handlers[method](malformed, context())).status).toBe(400);
    noWriters();
  });
  it("retains bounded JSON admission", async () => {
    const oversized = new Request("https://synthetic.invalid/api/ortho/41", {
      method, headers: { "Content-Length": String(JSON_BODY_LIMIT_BYTES + 1) }, body: "{}",
    });
    expect((await handlers[method](oversized, context())).status).toBe(413);
    noWriters();
  });
});

describe("writer outcomes stay unchanged", () => {
  it.each(["phase", "retainer"] as const)("retains PATCH %s conflict handling", async (field) => {
    vi.mocked(setOrthoPhase).mockResolvedValue(false);
    vi.mocked(setRetainer).mockResolvedValue(false);
    expect((await call("PATCH", field === "phase" ? { phase: "working" } : { retainer: "essix" })).status).toBe(409);
  });
  it.each(["phase", "retainer"] as const)("retains PATCH %s exception handling", async (field) => {
    vi.mocked(setOrthoPhase).mockRejectedValue(new Error("Synthetic failure"));
    vi.mocked(setRetainer).mockRejectedValue(new Error("Synthetic failure"));
    expect((await call("PATCH", field === "phase" ? { phase: "working" } : { retainer: "essix" })).status).toBe(500);
  });
  it("retains POST conflict handling after inherited phase normalization", async () => {
    vi.mocked(recordAdjustment).mockResolvedValue({ ok: false, message: "Synthetic closed case" });
    expect((await call("POST", { phase: "constructor" })).status).toBe(409);
    expect(recordAdjustment).toHaveBeenCalledWith(expect.objectContaining({ phase: null }));
  });
  it("retains POST replay response after normalization", async () => {
    vi.mocked(recordAdjustment).mockResolvedValue({ ok: true, id: 501, created: false, visitId: null, attachedToToday: false });
    const response = await call("POST", { phase: "__proto__" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 501, existing: true, visitId: null, attachedToToday: false });
  });
  it("retains POST exception handling after normalization", async () => {
    vi.mocked(recordAdjustment).mockRejectedValue(new Error("Synthetic failure"));
    expect((await call("POST", { phase: "toString" })).status).toBe(500);
  });
});
