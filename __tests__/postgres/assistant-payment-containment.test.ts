import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import type { AiToolContext } from "../../lib/ai-tools/types";

/**
 * Core-safety containment of the assistant's record_patient_payment execution path, on real
 * PostgreSQL 18 with synthetic users, patient, invoice and shift. The payment writer behind this
 * tool had no durable retry identity and no similar-collection review, so its execution is
 * withdrawn: refused before any confirmation is issued or consumed, previously issued signed tokens
 * refuse too, and the action itself refuses as a backstop (including its demo-mode branch). The
 * operator is directed to the existing guarded collection screen, which stays available and
 * protected. Every other assistant tool is unchanged. "Nothing written" is a content hash of every
 * table (the confirmation route's own audit line of a refused attempt is the one permitted row).
 */
assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_assistant_payment_containment_test");
const auth = vi.hoisted(() => ({ session: null as SessionPayload | null }));
vi.mock("@/lib/session", async (original) => ({ ...await original<typeof import("../../lib/session")>(), requireSession: async () => auth.session }));
const db = await import("../../lib/db");
const authLib = await import("../../lib/auth");
const { executeAiTool } = await import("../../lib/ai-tools/registry");
const { recordPatientPaymentAction, addPatientMedicalAlertAction } = await import("../../lib/ai-tools/action-tools");
const { processAssistantQuery } = await import("../../lib/assistant-engine");
const { buildToolConfirmationPayload, signToolConfirmation } = await import("../../lib/ai-confirmation");
const chatRoute = await import("../../app/api/ai/chat/route");
const confirmationRoute = await import("../../app/api/ai/confirmation/route");
const paymentsRoute = await import("../../app/api/payments/route");

const q = async <R = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as R[];
const PATIENT_NAME = "سالم الاصطناعي للاحتواء";
let admin: SessionPayload, reception: SessionPayload, doctor: SessionPayload;
let patientId = 0, invoiceId = 0;

beforeAll(async () => {
  await db.ensureSchema();
  const hash = await authLib.hashPassword("synthetic-containment-password");
  const user = async (username: string, role: string, permissions: Record<string, unknown> | null) => {
    const [row] = await q<{ id: number }>("INSERT INTO users(username,display_name,password_hash,role,is_active,permissions) VALUES($1,$2,$3,$4,TRUE,$5) RETURNING id",
      [username, `Synthetic ${role}`, hash, role, permissions ? JSON.stringify(permissions) : null]);
    return { userId: row.id, username, role, credentialVersion: authLib.sessionCredentialVersion(hash), expiresAt: Date.now() + 3_600_000 } as SessionPayload;
  };
  admin = await user("containment-admin", "admin", null);
  reception = await user("containment-reception", "reception", null);
  doctor = await user("containment-doctor", "doctor", null);
  await db.openShift({ openedBy: admin.username, opening: { YER: 0, SAR: 0, USD: 0 } });
  await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  db.invalidateSettingsCache();
  [{ id: patientId }] = await q<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES('CONTAIN-1',$1) RETURNING id", [PATIENT_NAME]);
  [{ id: invoiceId }] = await q<{ id: number }>("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency) VALUES('CONTAIN-INV',$1,100000,0,'YER') RETURNING id", [patientId]);
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

let stateSql: string | null = null;
/** One content hash per table. The refused-attempt audit line of the confirmation route is compared separately. */
async function databaseState(): Promise<Record<string, string>> {
  if (stateSql === null) {
    const tables = await q<{ name: string }>("SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1");
    stateSql = tables.map(({ name }) => `SELECT '${name}' AS t, count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM ${name} x${
      name === "public.audit_log" ? " WHERE x.action NOT IN ('ai.confirmation.execute', 'ai.chat')" : ""}`).join(" UNION ALL ");
  }
  return Object.fromEntries((await q<{ t: string; h: string }>(stateSql)).map((row) => [row.t, row.h]));
}
const changedTables = (before: Record<string, string>, after: Record<string, string>) => Object.keys(after).filter((table) => before[table] !== after[table]).sort();
const claims = async () => (await q<{ n: number }>("SELECT count(*)::int AS n FROM ai_confirmation_claims"))[0].n;
const context = (session: SessionPayload, extra: Partial<AiToolContext> = {}): AiToolContext => ({
  userId: session.userId, username: session.username, role: session.role as AiToolContext["role"], doctorPartyId: null, permissions: null,
  canViewAllPatients: true, canViewClinicFinance: session.role === "admin", canViewOwnCommissions: true, canManageInventory: session.role !== "doctor",
  todayISO: "2026-10-23", isDbConnected: true, ...extra,
});
const paymentParams = () => ({ patientId, invoiceId, amount: "5000", currency: "YER" as const, method: "cash" as const });
/** A token exactly as the offer path signed it before containment (a previously issued confirmation). */
const issuedToken = (session: SessionPayload, tool = "record_patient_payment", params: Record<string, unknown> = paymentParams()) =>
  signToolConfirmation(buildToolConfirmationPayload({ userId: session.userId, username: session.username, tool, params, patientId }));
const CONTAINED = /موقوف/;

function expectContained(result: { success: boolean; textSummary: string; confirmation?: unknown; requiresConfirmation?: boolean; actions?: { href?: string }[] }) {
  expect(result.success).toBe(false);
  expect(result.confirmation).toBeUndefined();
  expect(result.requiresConfirmation).not.toBe(true);
  expect(result.textSummary).toMatch(CONTAINED);
  expect(result.actions?.some((action) => action.href === "/finance")).toBe(true);
}

describe("record_patient_payment execution is contained", () => {
  it("the action itself refuses (real DB and demo mode) and writes nothing", async () => {
    const s0 = await databaseState();
    for (const isDbConnected of [true, false]) {
      const result = await recordPatientPaymentAction(paymentParams(), context(admin, { isDbConnected }));
      expectContained(result);
      expect(result.textSummary).not.toContain("وضع تجريبي");
    }
    expect(changedTables(s0, await databaseState())).toEqual([]);
  });

  it("normal dispatch through the local action engine issues no confirmation and writes nothing", async () => {
    const s0 = await databaseState(); const c0 = await claims();
    const ctx = context(admin);
    const response = await processAssistantQuery(`سجل دفعة 5000 ريال للمريض ${PATIENT_NAME}`, ctx, []);
    expect(response.intent).toBe("action_record_payment");
    expect(response.confirmation).toBeUndefined();
    expect(ctx.pendingConfirmation).toBeUndefined();
    expect(response.answer).toMatch(CONTAINED);
    expect(response.actions?.some((action) => action.href === "/finance")).toBe(true);
    expect(await claims()).toBe(c0);
    expect(changedTables(s0, await databaseState())).toEqual([]);
  });

  it.each(["record_patient_payment", "record_payment", "receive_payment", "record_receipt"])("a fresh request for %s gets no signed offer", async (tool) => {
    const s0 = await databaseState(); const c0 = await claims();
    for (const session of [admin, reception]) {
      const ctx = context(session);
      expectContained(await executeAiTool(tool, paymentParams(), ctx));
      expect(ctx.pendingConfirmation).toBeUndefined();
    }
    expect(await claims()).toBe(c0);
    expect(changedTables(s0, await databaseState())).toEqual([]);
  });

  it("a previously issued valid token refuses, is not consumed, and its replay refuses the same way", async () => {
    const s0 = await databaseState(); const c0 = await claims();
    for (const session of [admin, reception]) {
      const token = issuedToken(session);
      for (let attempt = 0; attempt < 3; attempt++) expectContained(await executeAiTool("record_patient_payment", paymentParams(), context(session, { confirmationToken: token })));
      const both = await Promise.all([1, 2].map(() => executeAiTool("record_patient_payment", paymentParams(), context(session, { confirmationToken: token }))));
      both.forEach(expectContained);
    }
    expect(await claims()).toBe(c0);
    expect(changedTables(s0, await databaseState())).toEqual([]);
  });

  it("malformed and unauthorized inputs stay refused by their existing gates, with nothing consumed or written", async () => {
    const s0 = await databaseState(); const c0 = await claims();
    const token = issuedToken(admin);
    const [body, signature] = token.split(".");
    const tamperedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString("utf8")), params: { ...paymentParams(), amount: "900000" } })).toString("base64url");
    const expired = signToolConfirmation({ ...buildToolConfirmationPayload({ userId: admin.userId, username: admin.username, tool: "record_patient_payment", params: paymentParams(), patientId }), exp: Date.now() - 1_000 });
    for (const [label, result, expected] of [
      ["tampered", await executeAiTool("record_patient_payment", paymentParams(), context(admin, { confirmationToken: `${tamperedBody}.${signature}` })), /غير صالح/],
      ["unsigned", await executeAiTool("record_patient_payment", paymentParams(), context(admin, { confirmationToken: body })), /غير صالح/],
      ["expired", await executeAiTool("record_patient_payment", paymentParams(), context(admin, { confirmationToken: expired })), /غير صالح|انتهت/],
      ["other user's token", await executeAiTool("record_patient_payment", paymentParams(), context(reception, { confirmationToken: token })), /مستخدم آخر/],
      ["doctor", await executeAiTool("record_patient_payment", paymentParams(), context(doctor)), /غير مصرح/],
      ["doctor with token", await executeAiTool("record_patient_payment", paymentParams(), context(doctor, { confirmationToken: issuedToken(doctor) })), /غير مصرح/],
    ] as const) {
      expect(result.success, label).toBe(false);
      expect(result.confirmation, label).toBeUndefined();
      expect(result.textSummary, label).toMatch(expected);
    }
    expect(await claims()).toBe(c0);
    expect(changedTables(s0, await databaseState())).toEqual([]);
  });
});

describe("the real assistant routes", () => {
  it("POST /api/ai/chat answers the payment command without an offer (this environment's demo-mode short-circuit included)", async () => {
    const s0 = await databaseState(); const c0 = await claims();
    auth.session = admin;
    const response = await chatRoute.POST(new Request("http://localhost/api/ai/chat", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: `سجل دفعة 5000 ريال للمريض ${PATIENT_NAME}` }) }));
    const data = await response.json() as Record<string, unknown>;
    expect(response.status, JSON.stringify(data)).toBe(200);
    expect(data.confirmation).toBeUndefined();
    expect(String(data.answer ?? data.reply ?? "")).toMatch(CONTAINED);
    expect(await claims()).toBe(c0);
    // The chat route's own request-rate counter is the only other row it touches; no money table moves.
    expect(changedTables(s0, await databaseState()).filter((table) => table !== "public.login_limits")).toEqual([]);
  });

  it("POST /api/ai/confirmation with a previously issued token refuses without consuming it or touching money", async () => {
    const s0 = await databaseState(); const c0 = await claims();
    auth.session = admin;
    const token = issuedToken(admin);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await confirmationRoute.POST(new Request("http://localhost/api/ai/confirmation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }));
      const data = await response.json() as Record<string, unknown>;
      expect(data.ok, JSON.stringify(data)).toBe(false);
      expect(String(data.reply)).toMatch(CONTAINED);
    }
    expect(await claims()).toBe(c0);
    expect(changedTables(s0, await databaseState())).toEqual([]);
    // The route's existing audit trail records each refused attempt as not executed.
    const audits = await q<{ executed: boolean }>("SELECT (details->>'executed')::boolean AS executed FROM audit_log WHERE action='ai.confirmation.execute' ORDER BY id DESC LIMIT 2");
    expect(audits).toEqual([{ executed: false }, { executed: false }]);
    // A user without the assistant permission is still refused by the route before the executor.
    auth.session = reception;
    const denied = await confirmationRoute.POST(new Request("http://localhost/api/ai/confirmation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: issuedToken(reception) }) }));
    expect(denied.status).toBe(403);
    expect(await claims()).toBe(c0);
  });
});

describe("the containment is narrow", () => {
  it("another state-changing assistant tool still issues its signed offer", async () => {
    const ctx = context(admin);
    const offer = await executeAiTool("add_patient_medical_alert", { patientId, medicalAlert: "حساسية بنسلين اصطناعية" }, ctx);
    expect(offer.requiresConfirmation).toBe(true);
    expect(offer.confirmation?.token).toBeTruthy();
    expect(typeof addPatientMedicalAlertAction).toBe("function");
  });

  it("the guarded collection screen's door stays available and protected", async () => {
    // Its own patient, so no receipt from another case can trigger the similar-receipt review.
    const [{ id: doorPatientId }] = await q<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES('CONTAIN-DOOR','Synthetic door patient') RETURNING id");
    const [{ id: doorInvoiceId }] = await q<{ id: number }>("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency) VALUES('CONTAIN-DOOR-INV',$1,100000,0,'YER') RETURNING id", [doorPatientId]);
    const send = (session: SessionPayload | null, key: string | null) => {
      auth.session = session;
      const headers: Record<string, string> = { "content-type": "application/json", "x-collection-similarity-review": "none" };
      if (key) headers["idempotency-key"] = key;
      return paymentsRoute.POST(new Request("http://localhost/api/payments", { method: "POST", headers,
        body: JSON.stringify({ kind: "payment", patientId: doorPatientId, invoiceId: doorInvoiceId, amount: "5000", currency: "YER", method: "cash" }) }));
    };
    expect((await send(doctor, "containment-door-doctor")).status).toBe(403);
    expect((await send(admin, null)).status).toBe(400);
    const recorded = await send(admin, "containment-door-admin-1");
    expect(recorded.status).toBe(201);
    const replay = await send(admin, "containment-door-admin-1");
    expect(replay.status).toBe(200);
    expect((await replay.json() as { id: number }).id).toBe((await recorded.json() as { id: number }).id);
  });
});
