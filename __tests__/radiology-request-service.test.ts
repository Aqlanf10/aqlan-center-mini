/** Real service + transaction wrapper with scripted DB boundaries. Not SQL/native-PG proof. */
import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionPayload } from "../lib/auth";
import { canonicalRadiologyRequest } from "../lib/radiology-request";
const fx = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), revalidate: vi.fn(), user: vi.fn(), access: vi.fn(), audit: vi.fn(), ensure: vi.fn(), readSession: vi.fn(), requireSession: vi.fn() }));
vi.mock("../lib/db", () => ({ ensureSchema: fx.ensure, getPool: () => ({ connect: async () => ({ query: fx.query, release: fx.release }) }), findUserByUsername: fx.user, insertAuditRow: fx.audit }));
vi.mock("../lib/session", () => ({ revalidateSessionInTransaction: fx.revalidate, readSessionPayload: fx.readSession, requireSession: fx.requireSession }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: fx.access }));
import { authorizeRadiologyPrint, issueRadiologyRequest, listRadiologyRequests, readRadiologyRequest, recoverRadiologyRequest, radiologyRequestOptions } from "../lib/radiology-request-service";
import { GET as recoverGET } from "../app/api/radiology-requests/commands/[key]/route";
import { GET as historyGET } from "../app/api/patients/[id]/radiology-requests/route";
import { POST as printPOST } from "../app/api/radiology-requests/[key]/print/route";
const key = "11111111-1111-4111-8111-111111111111", centerId = "22222222-2222-4222-8222-222222222222";
const draft = { patientId: 7, visitId: 9, centerId, examination: "بانوراما", region: "الفكين", notes: "" };
let session: SessionPayload;
let doctorActive: boolean, visitPatient: number, centerActive: boolean, centerMissing: boolean;
let previous: Record<string, unknown> | null;
function record() {
  return { command_key: key, actor_user_id: 3, actor_username: "synthetic", patient_id: 7, visit_id: 9, doctor_party_id: 5,
    payload_sha256: createHash("sha256").update(JSON.stringify([session.userId, session.username, canonicalRadiologyRequest(draft)])).digest("hex"),
    snapshot: { ...draft, version: 1, patientName: "Synthetic patient", doctorId: 5, clinicName: "Clinic", clinicAddress: "", clinicPhone: "", doctorName: "Original doctor", centerName: "Original center", centerAddress: "Original address", timeZone: "Asia/Aden" }, created_at: new Date("2026-11-01T00:00:00Z") };
}
const sqls = () => fx.query.mock.calls.map(call => call[0] as string);
const inserts = () => sqls().filter(sql => sql.startsWith("INSERT INTO radiology_requests"));
const denied = async (promise: Promise<unknown>, status: number) => { await expect(promise).rejects.toMatchObject({ status }); expect(inserts()).toHaveLength(0); expect(fx.audit).not.toHaveBeenCalled(); expect(sqls().at(-1)).toBe("ROLLBACK"); expect(fx.release).toHaveBeenCalledOnce(); };
beforeEach(() => {
  vi.clearAllMocks();
  session = { userId: 3, username: "synthetic", role: "doctor", credentialVersion: "synthetic-version", expiresAt: Date.now() + 60_000 } as SessionPayload;
  fx.readSession.mockImplementation(async () => session); fx.requireSession.mockImplementation(async () => session);
  doctorActive = true; visitPatient = 7; centerActive = true; centerMissing = false; previous = null;
  fx.revalidate.mockImplementation(async () => session);
  fx.user.mockResolvedValue({ id: 3, username: "synthetic", role: "doctor", partyId: 5, permissions: {} }); fx.access.mockResolvedValue(true); fx.audit.mockResolvedValue(undefined);
  fx.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM parties")) return { rows: [{ id: 5, name: "Current doctor", kind: "doctor", is_active: doctorActive }] };
    if (sql.includes("FROM visits")) return { rows: [{ patient_id: visitPatient }] };
    if (sql.includes("FROM patients")) return { rows: [{ full_name: "Synthetic patient" }] };
    if (sql.startsWith("SELECT key,value FROM settings")) return { rows: [{ key: "clinical.radiology_centers", value: JSON.stringify(centerMissing ? [] : [{ id: centerId, name: "Current center", address: "Current address", active: centerActive }]) }, { key: "clinic.name", value: "Clinic" }] };
    if (sql.startsWith("SELECT value FROM settings")) return { rows: [{ value: JSON.stringify([{ id: centerId, name: "Current center", address: "Current address", active: centerActive }]) }] };
    if (sql.startsWith("INSERT INTO radiology_requests")) return { rows: [{ ...record(), snapshot: JSON.parse(values![7] as string) }] };
    if (sql.startsWith("SELECT * FROM radiology_requests")) return { rows: previous ? [previous] : [] };
    throw new Error(`Unhandled synthetic query: ${sql}`);
  });
});
it("denies revoked session before clinical data reads", async () => {
  fx.revalidate.mockResolvedValue(null); await denied(issueRadiologyRequest(session, key, draft), 403);
  expect(fx.user).not.toHaveBeenCalled(); expect(sqls().some(sql => /FROM (patients|visits|radiology_requests|settings)/.test(sql))).toBe(false);
});
it("rejects mismatched visit before patient and saved-request reads", async () => {
  visitPatient = 8; await denied(issueRadiologyRequest(session, key, draft), 404);
  expect(sqls().some(sql => sql.includes("FROM patients") || sql.includes("FROM radiology_requests"))).toBe(false);
});
it("requires active clinician and patient access for issuance", async () => {
  doctorActive = false; await denied(issueRadiologyRequest(session, key, draft), 403);
  expect(sqls().some(sql => sql.includes("FROM patients"))).toBe(false);
});
it("refuses a patient outside the fresh access scope", async () => {
  fx.access.mockResolvedValue(false); await denied(issueRadiologyRequest(session, key, draft), 403);
  expect(fx.access).toHaveBeenCalledWith(session, 7, undefined, expect.anything(), "nowait");
});
it("permits explicit reception print/list access but never issue or issue options", async () => {
  fx.user.mockResolvedValue({ role: "reception", partyId: 5, permissions: { canPrintRadiologyRequests: true } }); previous = record();
  expect(await listRadiologyRequests(session, 7, null)).toMatchObject({ canIssue: false });
  expect(await readRadiologyRequest(session, key, 7)).toMatchObject({ id: key });
  fx.query.mockClear(); fx.release.mockClear(); await denied(issueRadiologyRequest(session, key, draft), 403);
  fx.query.mockClear(); fx.release.mockClear(); await denied(radiologyRequestOptions(session, 7, 9), 403);
});
it("does not infer reception printing from role alone", async () => {
  fx.user.mockResolvedValue({ role: "reception", partyId: null, permissions: {} }); await denied(readRadiologyRequest(session, key, 7), 403);
});
it.each(["missing", "inactive"])("rejects %s destination before insert", async kind => {
  centerMissing = kind === "missing"; centerActive = kind !== "inactive"; await denied(issueRadiologyRequest(session, key, draft), 409);
});
it("returns exact immutable replay without refreshing destination data, inserting, or auditing", async () => {
  previous = record(); centerMissing = true;
  const result = await issueRadiologyRequest(session, key, draft);
  expect(result).toMatchObject({ id: key, replayed: true, snapshot: { centerName: "Original center", doctorName: "Original doctor" } });
  expect(inserts()).toHaveLength(0); expect(fx.audit).not.toHaveBeenCalled(); expect(sqls().some(sql => sql.includes("FROM settings"))).toBe(false); expect(sqls().at(-1)).toBe("COMMIT");
});
it.each(["actor_user_id", "actor_username", "patient_id", "visit_id", "doctor_party_id", "payload_sha256"])("rejects replay collision in %s without mutation", async field => {
  previous = { ...record(), [field]: field.includes("sha") || field.includes("username") ? "different" : 123 };
  await denied(issueRadiologyRequest(session, key, draft), 409);
});
it("locks key, fresh clinician, visit, patient and settings before inserting and awaiting audit", async () => {
  const result = await issueRadiologyRequest(session, key, draft); expect(result.replayed).toBe(false);
  const logs = sqls(); const ordered = ["pg_advisory_xact_lock", "FROM parties", "FROM visits", "FROM patients", "SELECT * FROM radiology_requests", "FROM settings", "INSERT INTO radiology_requests"];
  const indices = ordered.map(part => logs.findIndex(sql => sql.includes(part))); expect(indices.every((value, i) => value >= 0 && (!i || value > indices[i - 1]))).toBe(true);
  for (const table of ["parties", "visits", "patients", "settings"]) expect(logs.find(sql => sql.includes(`FROM ${table}`))).toContain("FOR SHARE NOWAIT");
  expect(fx.audit).toHaveBeenCalledOnce(); expect(logs.at(-1)).toBe("COMMIT"); expect(fx.release).toHaveBeenCalledOnce();
});
it("rolls back rather than committing when awaited audit fails", async () => {
  fx.audit.mockRejectedValue(new Error("audit unavailable")); await expect(issueRadiologyRequest(session, key, draft)).rejects.toThrow("audit unavailable");
  expect(inserts()).toHaveLength(1); expect(sqls().at(-1)).toBe("ROLLBACK"); expect(sqls()).not.toContain("COMMIT"); expect(fx.release).toHaveBeenCalledOnce();
});
it("rolls back insertion and audit if session expires before final commit", async () => {
  fx.audit.mockImplementation(async () => { session.expiresAt = Date.now() - 1; }); await expect(issueRadiologyRequest(session, key, draft)).rejects.toMatchObject({ status: 403 });
  expect(inserts()).toHaveLength(1); expect(fx.audit).toHaveBeenCalledOnce(); expect(sqls().at(-1)).toBe("ROLLBACK"); expect(sqls()).not.toContain("COMMIT");
});
it("unknown recovery never inserts, acquires no issuance key lock, and preserves unknown semantics", async () => {
  expect(await recoverRadiologyRequest(session, key, 7, 9)).toEqual({ state: "unknown" });
  expect(inserts()).toHaveLength(0); expect(fx.audit).not.toHaveBeenCalled(); expect(sqls().some(sql => sql.includes("pg_advisory_xact_lock"))).toBe(false);
});

it.each([{ patientId: 8 }, { visitId: 10 }, { doctorId: 6 }, { version: 2 }, { timeZone: "Invalid/Zone" }, { centerName: "wrong\u202e" }])("fails closed when persisted identity or display context is malformed: %j", async patch => {
  previous = record(); previous.snapshot = { ...(previous.snapshot as Record<string, unknown>), ...patch };
  await expect(readRadiologyRequest(session, key, 7)).rejects.toThrow();
  expect(sqls().at(-1)).toBe("ROLLBACK"); expect(inserts()).toHaveLength(0); expect(fx.audit).not.toHaveBeenCalled();
});
it("recovery GET uses payload admission plus fresh transactional authority, with no initializer or writes", async () => {
  const response = await recoverGET(new Request(`http://test.invalid/api/radiology-requests/commands/${key}?patientId=7&visitId=9`), { params: Promise.resolve({ key }) });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ state: "unknown" }); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(fx.readSession).toHaveBeenCalledOnce(); expect(fx.requireSession).not.toHaveBeenCalled(); expect(fx.ensure).not.toHaveBeenCalled(); expect(fx.revalidate).toHaveBeenCalledOnce();
  expect(sqls().some(sql => /^(CREATE|ALTER|INSERT|UPDATE|DELETE|TRUNCATE)/.test(sql))).toBe(false);
});
it.each(["recovery", "history", "options"])("returns no-store503 for missing tables on %s GET without initialization", async mode => {
  const original = fx.query.getMockImplementation()!;
  fx.query.mockImplementation(async (sql: string, values?: unknown[]) => { if (sql.includes("FROM radiology_requests") || sql.includes("FROM settings")) throw Object.assign(new Error("synthetic missing table"), { code: "42P01" }); return original(sql, values); });
  const response = mode === "recovery" ? await recoverGET(new Request(`http://test.invalid/api/radiology-requests/commands/${key}?patientId=7`), { params: Promise.resolve({ key }) }) : await historyGET(new Request(`http://test.invalid/api/patients/7/radiology-requests${mode === "options" ? "?mode=options" : ""}`), { params: Promise.resolve({ id: "7" }) });
  expect(response.status).toBe(503); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ message: "خدمة طلبات الأشعة غير جاهزة؛ لم يتم إنشاء طلب جديد." });
  expect(fx.ensure).not.toHaveBeenCalled(); expect(fx.requireSession).not.toHaveBeenCalled(); expect(sqls().at(-1)).toBe("ROLLBACK");
});
it("rejects GET sessions without credential version before touching storage", async () => {
  fx.readSession.mockResolvedValue({ username: "synthetic" });
  const response = await recoverGET(new Request(`http://test.invalid/?patientId=7`), { params: Promise.resolve({ key }) });
  expect(response.status).toBe(401); expect(fx.query).not.toHaveBeenCalled(); expect(fx.ensure).not.toHaveBeenCalled();
});

it("authorizes manual printing with fresh reception grant and one awaited audit", async () => {
  previous = record(); fx.user.mockResolvedValue({ role: "reception", permissions: { canPrintRadiologyRequests: true } });
  const result = await authorizeRadiologyPrint(session, key, 7);
  expect(result).toEqual({ allowed: true, id: key, patientId: 7 }); expect(fx.revalidate).toHaveBeenCalledOnce();
  expect(fx.audit).toHaveBeenCalledOnce(); expect(fx.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "radiology_request.print", entityId: key, actor: "synthetic", details: { patientId: 7 } }));
  expect(inserts()).toHaveLength(0); expect(fx.ensure).not.toHaveBeenCalled(); expect(sqls().at(-1)).toBe("COMMIT");
});
it.each(["missing-grant", "revoked-session", "patient-access", "request-scope"])("refuses print with %s without audit", async kind => {
  previous = record();
  if (kind === "missing-grant") fx.user.mockResolvedValue({ role: "reception", permissions: {} });
  if (kind === "revoked-session") fx.revalidate.mockResolvedValue(null);
  if (kind === "patient-access") fx.access.mockResolvedValue(false);
  if (kind === "request-scope") previous = null;
  await denied(authorizeRadiologyPrint(session, key, 7), kind === "request-scope" ? 404 : 403);
  if (kind === "request-scope") expect(fx.query).toHaveBeenCalledWith("SELECT * FROM radiology_requests WHERE command_key=$1::uuid AND patient_id=$2", [key, 7]);
});
it.each(["audit-failure", "final-expiry"])("rolls back print authorization on %s", async kind => {
  previous = record();
  fx.audit.mockImplementation(async () => { if (kind === "audit-failure") throw new Error("audit unavailable"); session.expiresAt = Date.now() - 1; });
  await expect(authorizeRadiologyPrint(session, key, 7)).rejects.toThrow(); expect(fx.audit).toHaveBeenCalledOnce();
  expect(sqls().at(-1)).toBe("ROLLBACK"); expect(sqls()).not.toContain("COMMIT");
});
it("print POST returns authorization only after fresh audited service completion", async () => {
  previous = record();
  const response = await printPOST(new Request(`http://test.invalid/api/radiology-requests/${key}/print`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patientId: 7 }) }), { params: Promise.resolve({ key }) });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ allowed: true, id: key, patientId: 7 });
  expect(fx.audit).toHaveBeenCalledOnce(); expect(fx.ensure).not.toHaveBeenCalled(); expect(response.headers.get("cache-control")).toBe("no-store");
});
it("print POST denies freshly revoked reception grant without auditing", async () => {
  previous = record(); fx.user.mockResolvedValue({ role: "reception", permissions: { canPrintRadiologyRequests: false } });
  const response = await printPOST(new Request(`http://test.invalid/print`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patientId: 7 }) }), { params: Promise.resolve({ key }) });
  expect(response.status).toBe(403); expect(fx.audit).not.toHaveBeenCalled();
});
