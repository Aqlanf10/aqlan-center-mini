/** Peer-review regressions (findings 1–9 + independent findings 1–8) on real PostgreSQL 18.
 *
 * Every scenario is synthetic: an owned disposable database, test-signed canonical
 * claims, temporary document storage, and NO external network transport. */
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";

vi.mock("server-only", () => ({}));
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-peer-review-regressions-20261101");
const docsDir = mkdtempSync(join(tmpdir(), "aqlan-peer-review-docs-"));
vi.stubEnv("DOCUMENTS_DIR", docsDir);

const db = await import("../../lib/db");
const idem = await import("../../lib/http-idempotency");
const finance = await import("../../lib/canonical-invoices-payments-services");
const patientFinance = await import("../../lib/canonical-patient-finance-history");
const clinicFinance = await import("../../lib/canonical-clinic-finance");
const clinical = await import("../../lib/canonical-clinical-records");
const endoVisits = await import("../../lib/canonical-endo-visits");
const labCanon = await import("../../lib/canonical-lab");
const adminReports = await import("../../lib/canonical-admin-reports-settings");
const backupReadonly = await import("../../lib/canonical-backup-readonly");
const msgChannels = await import("../../lib/messaging-channels");
const messaging = await import("../../lib/canonical-messages-tasks");
const hrPayroll = await import("../../lib/hr-payroll");
const authMod = await import("../../lib/auth");
const issuer = await import("../../lib/staff-session-revocation");
const cleanup = await import("../../lib/file-cleanup");
const { LabFinancialBoundaryError } = await import("../../lib/lab-financial-boundary");
const { withStaffOperation } = await import("../../lib/staff-operation-runtime");

const ACCOUNTS = {
  owner: {
    username: "SYN-PR-OWNER",
    role: "admin",
    patientScope: "all",
    appointmentScope: "all",
    grants: { "staff.view": true, "reports.operational.view": true, "patients.edit": true, "patients.number.manage": true },
  },
  adminNonOwner: {
    username: "SYN-PR-ADMIN2",
    role: "admin",
    patientScope: "all",
    appointmentScope: "all",
    grants: { "patients.edit": true, "patients.number.manage": true },
  },
  cashierAll: {
    username: "SYN-PR-CASHIER", role: "cashier", patientScope: "all",
    grants: {
      "finance.invoices.view": true,
      "finance.invoices.create": true,
      "finance.payments.view": true,
      "finance.payments.collect": true,
      "finance.opening-balances.manage": true,
      "finance.patient-ledger.view": true,
      "finance.payables.record": true,
      "finance.suppliers.view": true,
      "clinical.lab.view": true,
      "reports.operational.view": true,
    },
  },
  financeNone: {
    username: "SYN-PR-FIN-NONE", role: "cashier", patientScope: "none",
    grants: {
      "finance.invoices.view": true,
      "finance.invoices.create": true,
      "finance.payments.view": true,
      "finance.payments.collect": true,
      "finance.opening-balances.manage": true,
      "finance.patient-ledger.view": true,
      "clinical.lab.view": true,
      "reports.operational.view": true,
    },
  },
  doctorOwn: {
    username: "SYN-PR-DOC", role: "doctor", doctor: true, patientScope: "own", appointmentScope: "own",
    grants: {
      "finance.invoices.view": true,
      "finance.invoices.create": true,
      "finance.payments.view": true,
      "finance.payments.collect": true,
      "finance.opening-balances.manage": true,
      "finance.patient-ledger.view": true,
      "clinical.lab.view": true,
      "reports.operational.view": true,
      "clinical.prescriptions.write": true,
      "clinical.visits.document": true,
      "clinical.visits.sign": true,
      "patients.edit": true,
      "patients.merge": true,
      "messages.use": true,
    },
  },
  reception: { username: "SYN-PR-RECEP", role: "reception", patientScope: "all", grants: { "messages.use": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
/** The fixture pool has max=1; genuine concurrency needs a separate pool on the same owned database. */
let wide: Pool;
const ids = { ownPatient: 0, otherPatient: 0, party: 0, shiftId: 0 };

const req = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  wide = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 8 });
  ids.ownPatient = (await fx.pool.query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-PR-P1','SYN PR Own','777900001',$1) RETURNING id",
    [fx.parties.doctorOwn!],
  )).rows[0].id;
  ids.otherPatient = (await fx.pool.query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name,phone) VALUES('SYN-PR-P2','SYN PR Other','777900002') RETURNING id",
  )).rows[0].id;
  ids.party = (await fx.pool.query<{ id: number }>(
    "INSERT INTO parties(name,kind,is_active) VALUES('SYN PR Supplier','supplier',TRUE) RETURNING id",
  )).rows[0].id;
  ids.shiftId = (await fx.pool.query<{ id: number }>(
    "INSERT INTO cashier_shifts(opened_by,opening_yer,opening_sar,opening_usd) VALUES($1,500000,0,0) RETURNING id",
    [ACCOUNTS.owner.username],
  )).rows[0].id;
  await fx.pool.query(
    "INSERT INTO settings(key,value) VALUES ('fx.USD_to_YER','530'),('fx.SAR_to_YER','140') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
  );
}, 180_000);

afterAll(async () => {
  await wide?.end();
  await fx?.close();
  rmSync(docsDir, { recursive: true, force: true });
});

describe("Finding 1/9 — transactional idempotency (advisory lock + same-transaction receipt)", () => {
  it("two concurrent first-use requests with one key execute exactly once", async () => {
    await fx.pool.query("CREATE TABLE IF NOT EXISTS pr_effects(id SERIAL PRIMARY KEY, tag TEXT NOT NULL)");
    const run = async () => {
      const client = await wide.connect();
      try {
        await client.query("BEGIN");
        const result = await idem.withHttpIdempotencyInTx(
          client, req("http://x/y", {}, { "idempotency-key": "pr-concurrent-0001" }), "pr.effects", "actor-a", { v: 1 },
          async () => {
            await client.query("INSERT INTO pr_effects(tag) VALUES('concurrent')");
            await client.query("SELECT pg_sleep(0.3)");
            return { status: 201, body: { ok: true } };
          },
        );
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    };
    const [a, b] = await Promise.all([run(), run()]);
    const { rows: [{ n }] } = await fx.pool.query<{ n: number }>("SELECT count(*)::int n FROM pr_effects WHERE tag='concurrent'");
    expect(n).toBe(1);
    expect([a.status, b.status].sort()).toEqual([201, 201]);
    expect([a.replay === true, b.replay === true].filter(Boolean)).toHaveLength(1);
  });

  it("a rolled-back domain transaction leaves no receipt, so the retry executes once", async () => {
    const client = await wide.connect();
    try {
      await client.query("BEGIN");
      await idem.withHttpIdempotencyInTx(client, req("http://x/y", {}, { "idempotency-key": "pr-rollback-0001" }), "pr.effects", "actor-a", { v: 2 },
        async () => { await client.query("INSERT INTO pr_effects(tag) VALUES('rolled')"); return { status: 201, body: {} }; });
      await client.query("ROLLBACK");
    } finally { client.release(); }
    const { rows } = await fx.pool.query("SELECT 1 FROM http_idempotency_keys WHERE idempotency_key='pr-rollback-0001'");
    expect(rows).toHaveLength(0);
  });

  it("a payload change under one key is refused (409 idempotency_conflict)", async () => {
    const client = await wide.connect();
    try {
      await client.query("BEGIN");
      const conflict = await idem.withHttpIdempotencyInTx(client, req("http://x/y", {}, { "idempotency-key": "pr-concurrent-0001" }), "pr.effects", "actor-a", { v: 999 },
        async () => ({ status: 201, body: {} }));
      await client.query("COMMIT");
      expect(conflict.status).toBe(409);
      expect((conflict.body as { reason: string }).reason).toBe("idempotency_conflict");
    } finally { client.release(); }
  });

  it("concurrent canonical payables with one Idempotency-Key create exactly one payable", async () => {
    const session = await fx.session("cashierAll");
    const body = { partyId: ids.party, description: "SYN PR payable", currency: "YER", amount: "1000" };
    const call = () => clinicFinance.payablesPostCanonicalResponse(req("http://localhost/api/payables", body, { "idempotency-key": "pr-payable-0001" }), session);
    const responses = await Promise.all([call(), call(), call()]);
    const { rows: [{ n }] } = await fx.pool.query<{ n: number }>("SELECT count(*)::int n FROM payables WHERE description='SYN PR payable'");
    expect(n).toBe(1);
    expect(responses.map((r) => r.status).every((s) => s === 201 || s === 200)).toBe(true);
  });
});

describe("Finding 1 — standalone (legacy) idempotency never takes over or re-executes", () => {
  it("an aged in_progress marker (>60s) fails closed instead of re-executing", async () => {
    const hash = createHash("sha256").update(idem.canonicalJson({ v: 1 })).digest("hex");
    await fx.pool.query(
      "INSERT INTO http_idempotency_keys(scope,actor,idempotency_key,request_hash,state,created_at) VALUES('pr.legacy','u1','pr-aged-000001',$1,'in_progress',NOW()-INTERVAL '10 minutes')",
      [hash],
    );
    let executed = 0;
    const res = await idem.withHttpIdempotency(req("http://x", {}, { "idempotency-key": "pr-aged-000001" }), "pr.legacy", "u1", { v: 1 },
      async () => { executed += 1; return Response.json({ ok: true }, { status: 201 }) as never; }, wide);
    expect(executed).toBe(0);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("idempotency_outcome_uncertain");
  });

  it("while the first request is still running, a second one is refused even if its marker looks old", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let executed = 0;
    const first = idem.withHttpIdempotency(req("http://x", {}, { "idempotency-key": "pr-slow-0000001" }), "pr.legacy", "u1", { v: 3 },
      async () => { executed += 1; await gate; return Response.json({ ok: true }, { status: 201 }) as never; }, wide);
    await new Promise((r) => setTimeout(r, 150));
    try {
    await wide.query("UPDATE http_idempotency_keys SET created_at=NOW()-INTERVAL '5 minutes' WHERE idempotency_key='pr-slow-0000001'");
    const second = await idem.withHttpIdempotency(req("http://x", {}, { "idempotency-key": "pr-slow-0000001" }), "pr.legacy", "u1", { v: 3 },
      async () => { executed += 1; return Response.json({ ok: true }, { status: 201 }) as never; }, wide);
    expect(second.status).toBe(409);
    } finally {
      release();
    }
    expect((await first).status).toBe(201);
    expect(executed).toBe(1);
  });

  it("an error after a possible commit keeps the marker; the retry does not re-execute", async () => {
    let executed = 0;
    await expect(idem.withHttpIdempotency(req("http://x", {}, { "idempotency-key": "pr-ambig-000001" }), "pr.legacy", "u1", { v: 4 },
      async () => { executed += 1; throw new Error("lost reply after commit"); }, fx.pool)).rejects.toThrow("lost reply");
    const retry = await idem.withHttpIdempotency(req("http://x", {}, { "idempotency-key": "pr-ambig-000001" }), "pr.legacy", "u1", { v: 4 },
      async () => { executed += 1; return Response.json({ ok: true }, { status: 201 }) as never; }, wide);
    expect(executed).toBe(1);
    expect(retry.status).toBe(409);
  });

  it("a definite 4xx refusal releases the key so a corrected retry can run", async () => {
    let executed = 0;
    const refused = await idem.withHttpIdempotency(req("http://x", {}, { "idempotency-key": "pr-refuse-00001" }), "pr.legacy", "u1", { v: 5 },
      async () => { executed += 1; return Response.json({ message: "invalid" }, { status: 400 }) as never; }, wide);
    expect(refused.status).toBe(400);
    const ok = await idem.withHttpIdempotency(req("http://x", {}, { "idempotency-key": "pr-refuse-00001" }), "pr.legacy", "u1", { v: 5 },
      async () => { executed += 1; return Response.json({ ok: true }, { status: 201 }) as never; }, wide);
    expect(ok.status).toBe(201);
    expect(executed).toBe(2);
  });
});

describe("Finding 8 / independent 2 — patient scope 'none' never falls through in finance", () => {
  it("invoice list: none=403, own-other=403, own-own=200, all=200", async () => {
    const list = (key: Key, patientId: number) =>
      fx.session(key).then((s) => finance.invoicesListCanonicalResponse(req(`http://localhost/api/invoices?patientId=${patientId}`), s));
    expect((await list("financeNone", ids.ownPatient)).status).toBe(403);
    expect((await list("doctorOwn", ids.otherPatient)).status).toBe(403);
    expect((await list("doctorOwn", ids.ownPatient)).status).toBe(200);
    expect((await list("cashierAll", ids.otherPatient)).status).toBe(200);
  });

  it("day payments list: none=403 (previously returned every patient's receipts)", async () => {
    const res = await finance.paymentsListCanonicalResponse(req("http://localhost/api/payments"), await fx.session("financeNone"));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("patient_scope_denied");
    expect((await finance.paymentsListCanonicalResponse(req("http://localhost/api/payments"), await fx.session("cashierAll"))).status).toBe(200);
  });
});

describe("Finding 2 — prescription replay re-proves live authority", () => {
  it("a cached 201 is NOT replayed after the prescriber's grant is revoked", async () => {
    const body = {
      patientId: ids.ownPatient,
      items: [{ name: "Paracetamol", dose: "500mg", form: "Tablets", frequency: "q8h", duration: "3d", selection: { id: "manual", amount: "1 box", confirmed: true } }],
    };
    const key = { "idempotency-key": "pr-rx-replay-0001" };
    const first = await clinical.commandCanonicalPrescriptionCreate(req("http://localhost/api/prescriptions", body, key), await fx.session("doctorOwn"), body, wide);
    expect(first.status).toBe(201);
    const replay = await clinical.commandCanonicalPrescriptionCreate(req("http://localhost/api/prescriptions", body, key), await fx.session("doctorOwn"), body, wide);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    const { rows: [{ n }] } = await fx.pool.query<{ n: number }>("SELECT count(*)::int n FROM prescriptions WHERE patient_id=$1", [ids.ownPatient]);
    expect(n).toBe(1);

    const grants = { ...ACCOUNTS.doctorOwn.grants } as Record<string, boolean>;
    delete grants["clinical.prescriptions.write"];
    await fx.setGrants("doctorOwn", grants, { patientScope: "own", appointmentScope: "own" });
    const revoked = await clinical.commandCanonicalPrescriptionCreate(req("http://localhost/api/prescriptions", body, key), await fx.session("doctorOwn"), body, wide);
    expect(revoked.status).toBe(403);
    await fx.setGrants("doctorOwn", { ...ACCOUNTS.doctorOwn.grants }, { patientScope: "own", appointmentScope: "own" });
  });
});

describe("Finding 3/5 — outbound messages: reservation before transport, never re-send on uncertainty", () => {
  const msg = (patientId: number | null, to = "777900001") => ({ channel: "sms", patientId, to, body: "SYN reminder", purpose: "manual" });

  it("an uncertain prior attempt (in_progress) fails closed and creates no delivery", async () => {
    const session = await fx.session("reception");
    const before = (await fx.pool.query<{ n: number }>("SELECT count(*)::int n FROM message_deliveries")).rows[0].n;
    // First attempt: channel not configured => refused before transport => reservation released.
    const refused = await messaging.messagesOutboundPostCanonicalResponse(req("http://localhost/api/messages/outbound", msg(ids.ownPatient), { "idempotency-key": "pr-msg-00000001" }), session);
    expect(refused.status).toBe(409);
    expect((await fx.pool.query("SELECT 1 FROM http_idempotency_keys WHERE idempotency_key='pr-msg-00000001'")).rows).toHaveLength(0);
    // Simulate an attempt whose transport outcome is unknown (crash after dispatch).
    const subject = (await fx.pool.query<{ realm: string; subject: string }>(
      "SELECT c.realm_id::text realm, b.subject_id::text subject FROM staff_authority_control c CROSS JOIN staff_identity_current b WHERE b.user_id=$1", [fx.ids.reception],
    )).rows[0];
    const hash = createHash("sha256").update(idem.canonicalJson({ channel: "sms", to: "777900001", subject: null, body: "SYN reminder", patientId: ids.ownPatient, purpose: "manual", replyToInboundId: null })).digest("hex");
    await fx.pool.query(
      "INSERT INTO http_idempotency_keys(scope,actor,idempotency_key,request_hash,state) VALUES('messages.outbound',$1,'pr-msg-00000002',$2,'in_progress')",
      [`canon:${subject.realm}:${subject.subject}`, hash],
    );
    const uncertain = await messaging.messagesOutboundPostCanonicalResponse(req("http://localhost/api/messages/outbound", msg(ids.ownPatient), { "idempotency-key": "pr-msg-00000002" }), session);
    expect(uncertain.status).toBe(409);
    expect((await uncertain.json()).code).toBe("outbound_delivery_uncertain");
    const after = (await fx.pool.query<{ n: number }>("SELECT count(*)::int n FROM message_deliveries")).rows[0].n;
    expect(after).toBe(before);
  });

  it("a doctor outside the patient's scope is refused before any reservation", async () => {
    const res = await messaging.messagesOutboundPostCanonicalResponse(req("http://localhost/api/messages/outbound", msg(ids.otherPatient, "777900002"), { "idempotency-key": "pr-msg-00000003" }), await fx.session("doctorOwn"));
    expect(res.status).toBe(403);
    expect((await fx.pool.query("SELECT 1 FROM http_idempotency_keys WHERE idempotency_key='pr-msg-00000003'")).rows).toHaveLength(0);
  });
});

describe("Finding 4 / independent 6 — canonical logout revokes only from a current token", () => {
  it("a revoked token cannot revoke a newer session", async () => {
    const old = await fx.session("cashierAll");
    expect(await issuer.revokeCanonicalStaffSessionIn(fx.pool, "public", old)).toBe(true);
    await expect(withStaffOperation(fx.pool, old, "finance.payments.view", async () => 1)).rejects.toThrow(/STAFF_OPERATION_/);
    const fresh = await fx.session("cashierAll");
    expect(await withStaffOperation(fx.pool, fresh, "finance.payments.view", async () => 1)).toBe(1);
    // Replaying logout with the already-revoked token is a strict no-op.
    expect(await issuer.revokeCanonicalStaffSessionIn(fx.pool, "public", old)).toBe(false);
    expect(await withStaffOperation(fx.pool, fresh, "finance.payments.view", async () => 2)).toBe(2);
  });
});

describe("Finding 6 / independent 8 — content-addressed file reconciliation", () => {
  const writeObject = (bytes: Buffer, deduplicated: boolean) => {
    const key = cleanup.plannedStorageKey(bytes, "png");
    const path = join(docsDir, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return { key, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, deduplicated, path };
  };

  it("removes only a new, unreferenced object; keeps deduplicated and referenced ones", async () => {
    const orphan = writeObject(Buffer.from("orphan-object"), false);
    expect(await cleanup.cleanupUncommittedStoredFile(orphan, wide)).toBe(true);
    expect(existsSync(orphan.path)).toBe(false);

    const shared = writeObject(Buffer.from("shared-object"), true);
    expect(await cleanup.cleanupUncommittedStoredFile(shared, wide)).toBe(false);
    expect(existsSync(shared.path)).toBe(true);

    const referenced = writeObject(Buffer.from("referenced-object"), false);
    await fx.pool.query(
      "INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,'other','SYN',$2,$3,$4,$5,'syn')",
      [ids.ownPatient, "image/png", referenced.sizeBytes, referenced.sha256, referenced.key],
    );
    expect(await cleanup.cleanupUncommittedStoredFile(referenced, wide)).toBe(false);
    expect(existsSync(referenced.path)).toBe(true);
  });

  it("waits for a concurrent uploader of the same content and keeps the object it commits", async () => {
    const obj = writeObject(Buffer.from("race-object"), false);
    const uploader = await wide.connect();
    try {
      await uploader.query("BEGIN");
      await cleanup.holdStorageKeyShared(uploader, obj.key);
      const pending = cleanup.cleanupUncommittedStoredFile(obj, wide);
      await new Promise((r) => setTimeout(r, 200));
      await uploader.query(
        "INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,'other','SYN race',$2,$3,$4,$5,'syn')",
        [ids.ownPatient, "image/png", obj.sizeBytes, obj.sha256, obj.key],
      );
      await uploader.query("COMMIT");
      expect(await pending).toBe(false);
      expect(existsSync(obj.path)).toBe(true);
    } finally {
      uploader.release();
    }
  });
});

describe("Finding 2 (extended) — patientScope 'none' / 'own' / 'all' across financial mutations, ownership loss, debts & lab summary", () => {
  it("enforces none=403, own-other=403, own-own=2xx, and 403 immediately after primary_doctor_id reassignment", async () => {
    const svcId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO services(name,category,price_minor,price_configured,price_provisional,is_active,sort_order) VALUES('SYN PR Cleaning','cleaning',15000,TRUE,FALSE,TRUE,1) RETURNING id",
      )
    ).rows[0].id;
    await db.openShiftWith(fx.pool, { openedBy: ACCOUNTS.owner.username, opening: { YER: 0, SAR: 0, USD: 0 } }).catch(() => {});

    const invBody = (patientId: number, key: string) => ({
      patientId,
      currency: "YER",
      idempotencyKey: key,
      items: [{ serviceId: svcId, description: "SYN PR Cleaning", quantity: 1, price: "15000", scope: "full_mouth", catalogPriceMinor: 15000 }],
    });

    // Invoice create: none=403, own-other=403, own-own=201
    expect(
      (await finance.invoicesCreateCanonicalResponse(req("http://localhost/api/invoices", invBody(ids.ownPatient, "pr-inv-none-0001")), await fx.session("financeNone"))).status,
    ).toBe(403);
    expect(
      (await finance.invoicesCreateCanonicalResponse(req("http://localhost/api/invoices", invBody(ids.otherPatient, "pr-inv-other-001")), await fx.session("doctorOwn"))).status,
    ).toBe(403);
    const ownInvRes = await finance.invoicesCreateCanonicalResponse(
      req("http://localhost/api/invoices", invBody(ids.ownPatient, "pr-inv-own-00001")),
      await fx.session("doctorOwn"),
    );
    expect(ownInvRes.status).toBe(201);
    const ownInv = (await ownInvRes.json()) as { id: number };

    // Foreign invoice created by cashierAll for debts/payment scope tests
    const otherInvRes = await finance.invoicesCreateCanonicalResponse(
      req("http://localhost/api/invoices", invBody(ids.otherPatient, "pr-inv-cash-0001")),
      await fx.session("cashierAll"),
    );
    expect(otherInvRes.status).toBe(201);
    const otherInv = (await otherInvRes.json()) as { id: number };

    // Payment create: none=403, own-other=403, own-own=201
    const payHeaders = (key: string) => ({ "x-collection-similarity-review": "none", "idempotency-key": key });
    expect(
      (await finance.paymentsCreateCanonicalResponse(
        req("http://localhost/api/payments", { patientId: ids.ownPatient, invoiceId: ownInv.id, currency: "YER", amount: "5000", method: "cash" }, payHeaders("pr-pay-none-0001")),
        await fx.session("financeNone"),
      )).status,
    ).toBe(403);
    expect(
      (await finance.paymentsCreateCanonicalResponse(
        req("http://localhost/api/payments", { patientId: ids.otherPatient, invoiceId: otherInv.id, currency: "YER", amount: "5000", method: "cash" }, payHeaders("pr-pay-other-001")),
        await fx.session("doctorOwn"),
      )).status,
    ).toBe(403);
    expect(
      (await finance.paymentsCreateCanonicalResponse(
        req("http://localhost/api/payments", { patientId: ids.ownPatient, invoiceId: ownInv.id, currency: "YER", amount: "5000", method: "cash" }, payHeaders("pr-pay-own-00001")),
        await fx.session("doctorOwn"),
      )).status,
    ).toBe(201);

    // Opening balance mutation: none=403, own-other=403, own-own=200
    expect(
      (await patientFinance.setOpeningBalanceCanonicalResponse(
        await fx.session("financeNone"),
        req("http://localhost/api/opening-balances", { patientId: ids.ownPatient, currency: "SAR", amount: "50" }),
      )).status,
    ).toBe(403);
    expect(
      (await patientFinance.setOpeningBalanceCanonicalResponse(
        await fx.session("doctorOwn"),
        req("http://localhost/api/opening-balances", { patientId: ids.otherPatient, currency: "SAR", amount: "50" }),
      )).status,
    ).toBe(403);
    expect(
      (await patientFinance.setOpeningBalanceCanonicalResponse(
        await fx.session("doctorOwn"),
        req("http://localhost/api/opening-balances", { patientId: ids.ownPatient, currency: "SAR", amount: "50" }),
      )).status,
    ).toBe(201);

    // Debts report: none=403, own returns ONLY ownPatient, all returns both
    expect((await clinicFinance.debtsGetCanonicalResponse(await fx.session("financeNone"))).status).toBe(403);
    const ownDebtsRes = await clinicFinance.debtsGetCanonicalResponse(await fx.session("doctorOwn"));
    expect(ownDebtsRes.status).toBe(200);
    const ownDebtIds = ((await ownDebtsRes.json()) as { rows: Array<{ patientId: number }> }).rows.map((r) => r.patientId);
    expect(ownDebtIds).toContain(ids.ownPatient);
    expect(ownDebtIds).not.toContain(ids.otherPatient);

    const allDebtsRes = await clinicFinance.debtsGetCanonicalResponse(await fx.session("cashierAll"));
    expect(allDebtsRes.status).toBe(200);
    const allDebtIds = ((await allDebtsRes.json()) as { rows: Array<{ patientId: number }> }).rows.map((r) => r.patientId);
    expect(allDebtIds).toEqual(expect.arrayContaining([ids.ownPatient, ids.otherPatient]));

    // Lab summary (?summary=1): none=403, own counts only ownPatient's lab orders
    await fx.pool.query(
      "INSERT INTO lab_orders(patient_id,doctor_id,lab_name,work_type,status,due_date) VALUES ($1,$2,'SYN Lab','Crown','sent',CURRENT_DATE+3),($3,NULL,'SYN Lab','Bridge','sent',CURRENT_DATE+3)",
      [ids.ownPatient, fx.parties.doctorOwn!, ids.otherPatient],
    );
    expect((await labCanon.readCanonicalLabResponse(await fx.session("financeNone"), req("http://localhost/api/lab?summary=1"))).status).toBe(403);
    const ownLabSummary = await (await labCanon.readCanonicalLabResponse(await fx.session("doctorOwn"), req("http://localhost/api/lab?summary=1"))).json();
    const allLabSummary = await (await labCanon.readCanonicalLabResponse(await fx.session("cashierAll"), req("http://localhost/api/lab?summary=1"))).json();
    expect(ownLabSummary.outstanding).toBe(1);
    expect(allLabSummary.outstanding).toBeGreaterThanOrEqual(2);

    // Ownership loss: reassigning primary_doctor_id away from doctorOwn revokes access on existing patient
    const transientPatient = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-PR-LOST','SYN Lost',$1) RETURNING id",
        [fx.parties.doctorOwn!],
      )
    ).rows[0].id;
    expect(
      (await finance.invoicesListCanonicalResponse(req(`http://localhost/api/invoices?patientId=${transientPatient}`), await fx.session("doctorOwn"))).status,
    ).toBe(200);
    await fx.pool.query("UPDATE patients SET primary_doctor_id = NULL WHERE id = $1", [transientPatient]);
    expect(
      (await finance.invoicesListCanonicalResponse(req(`http://localhost/api/invoices?patientId=${transientPatient}`), await fx.session("doctorOwn"))).status,
    ).toBe(403);
    expect(
      (await finance.invoicesCreateCanonicalResponse(req("http://localhost/api/invoices", invBody(transientPatient, "pr-inv-lost-0001")), await fx.session("doctorOwn"))).status,
    ).toBe(403);
  });
});

describe("Finding 4 — clinical visit sign replay re-proves live authority AND canonical paths never call ensureSchema()", () => {
  it("refuses cached clinical visit sign replay after clinical.visits.sign is revoked, and keeps ensureSchema call count at 0", async () => {
    const svcId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO services(name,category,price_minor,price_configured,price_provisional,is_active,sort_order) VALUES('SYN PR Visit Exam','exam',10000,TRUE,FALSE,TRUE,2) RETURNING id",
      )
    ).rows[0].id;
    const visitId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO visits(patient_name,patient_id,doctor_id,status) VALUES('SYN PR Own',$1,$2,'in_chair') RETURNING id",
        [ids.ownPatient, fx.parties.doctorOwn!],
      )
    ).rows[0].id;

    const spy = vi.spyOn(db, "ensureSchema");
    spy.mockClear();
    try {
      const saved = await endoVisits.handleCanonicalClinicalVisitPost(
        req(`http://localhost/api/visits/${visitId}/clinical`, { action: "save" }),
        await fx.session("doctorOwn"),
        visitId,
        {
          action: "save",
          chiefComplaint: "فحص دوري",
          diagnosis: "سليم",
          doctorId: fx.parties.doctorOwn!,
          procedures: [{ serviceId: svcId, quantity: 1, unitPriceMinor: 10000, doctorId: fx.parties.doctorOwn! }],
        },
        wide,
      );
      expect(saved.status).toBe(200);

      const signReq = () =>
        new Request(`http://localhost/api/visits/${visitId}/clinical`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": "pr-visit-sign-0001" },
          body: JSON.stringify({ action: "sign" }),
        });

      const signed1 = await endoVisits.handleCanonicalClinicalVisitPost(signReq(), await fx.session("doctorOwn"), visitId, { action: "sign" }, wide);
      expect(signed1.status).toBe(200);
      const signed2 = await endoVisits.handleCanonicalClinicalVisitPost(signReq(), await fx.session("doctorOwn"), visitId, { action: "sign" }, wide);
      expect(signed2.status).toBe(200);
      expect(signed2.headers.get("X-Idempotent-Replay")).toBe("true");

      // Exercise canonical operational report & debts as well under the ensureSchema spy
      expect((await adminReports.canonicalOperationalReportGet(await fx.session("doctorOwn"), req("http://localhost/api/operational-report"))).status).toBe(200);
      expect((await clinicFinance.debtsGetCanonicalResponse(await fx.session("doctorOwn"))).status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(0);

      // Revoke clinical.visits.sign -> cached replay MUST be denied (403)
      const grants = { ...ACCOUNTS.doctorOwn.grants } as Record<string, boolean>;
      delete grants["clinical.visits.sign"];
      await fx.setGrants("doctorOwn", grants, { patientScope: "own", appointmentScope: "own" });
      try {
        const deniedReplay = await endoVisits.handleCanonicalClinicalVisitPost(signReq(), await fx.session("doctorOwn"), visitId, { action: "sign" }, wide);
        expect(deniedReplay.status).toBe(403);
      } finally {
        await fx.setGrants("doctorOwn", { ...ACCOUNTS.doctorOwn.grants }, { patientScope: "own", appointmentScope: "own" });
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Finding 5 (owner-test outbound) — durable reservation + post-delivery failure never triggers duplicate transport", () => {
  it("delivers once via local stub, replays without calling fetch again, and fails closed on in_progress", async () => {
    await db.saveMessagingChannelInTransaction(fx.pool, {
      channel: "sms",
      enabled: false,
      config: { ...msgChannels.DEFAULT_CONFIG.sms, url: "https://sms.invalid/send" },
      secrets: { apiKey: "syn-test-sms-secret" },
      actor: ACCOUNTS.owner.username,
      actorRole: "admin",
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("OK", { status: 200 }));
    try {
      const ownerSession = await fx.session("owner");
      const first = await backupReadonly.canonicalMessagingTestPost(
        ownerSession,
        req("http://localhost/api/settings/messaging/test", { channel: "sms", to: "777900099" }, { "idempotency-key": "pr-msg-test-0001" }),
      );
      expect(first.status).toBe(200);
      expect((await first.json()).ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Replay with same Idempotency-Key returns 200 without invoking fetch a second time
      const replay = await backupReadonly.canonicalMessagingTestPost(
        ownerSession,
        req("http://localhost/api/settings/messaging/test", { channel: "sms", to: "777900099" }, { "idempotency-key": "pr-msg-test-0001" }),
      );
      expect(replay.status).toBe(200);
      expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Non-owner admin is refused 403 with zero fetch calls
      const denied = await backupReadonly.canonicalMessagingTestPost(
        await fx.session("adminNonOwner"),
        req("http://localhost/api/settings/messaging/test", { channel: "sms", to: "777900099" }, { "idempotency-key": "pr-msg-test-0002" }),
      );
      expect(denied.status).toBe(403);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Simulated crash during transport (in_progress row): retry fails closed (409) without re-sending
      const subject = (
        await fx.pool.query<{ realm: string; subject: string }>(
          "SELECT c.realm_id::text realm, b.subject_id::text subject FROM staff_authority_control c CROSS JOIN staff_identity_current b WHERE b.user_id=$1",
          [fx.ids.owner],
        )
      ).rows[0];
      const hash = createHash("sha256")
        .update(idem.canonicalJson({ channel: "sms", to: "777900088" }))
        .digest("hex");
      await fx.pool.query(
        "INSERT INTO http_idempotency_keys(scope,actor,idempotency_key,request_hash,state) VALUES('settings.messaging.test',$1,'pr-msg-test-0003',$2,'in_progress')",
        [`canon:${subject.realm}:${subject.subject}`, hash],
      );
      const uncertain = await backupReadonly.canonicalMessagingTestPost(
        ownerSession,
        req("http://localhost/api/settings/messaging/test", { channel: "sms", to: "777900088" }, { "idempotency-key": "pr-msg-test-0003" }),
      );
      expect(uncertain.status).toBe(409);
      expect((await uncertain.json()).code).toBe("outbound_delivery_uncertain");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("Finding 7 — payroll ambiguous-error recovery checks full request fingerprint", () => {
  it("replays identical disbursement parameters and throws key_conflict (409) when amount/item/actor differs", async () => {
    const staffId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO hr_staff(full_name,job_title,department,work_status,hire_date,contract_kind,salary_amount_minor,salary_currency,salary_period,salary_effective_on,created_by) VALUES('SYN PR Staff','Nurse','nursing','active','2026-01-01','salary',50000,'YER','monthly','2026-01-01',$1) RETURNING id",
        [ACCOUNTS.owner.username],
      )
    ).rows[0].id;
    const periodId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO hr_payroll_periods(period_key,name,start_date,end_date,status,created_by) VALUES('2026-10','SYN Oct 2026','2026-10-01','2026-10-31','approved',$1) RETURNING id",
        [ACCOUNTS.owner.username],
      )
    ).rows[0].id;
    const runId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO hr_payroll_runs(period_id,status,currency,created_by) VALUES($1,'approved','YER',$2) RETURNING id",
        [periodId, ACCOUNTS.owner.username],
      )
    ).rows[0].id;
    const itemId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO hr_payroll_items(run_id,staff_id,currency,base_salary_minor,net_due_minor,paid_minor,remaining_minor,status,pay_terms_snapshot) VALUES($1,$2,'YER',50000,50000,10000,40000,'partially_paid','{\"source\":\"staff\"}'::jsonb) RETURNING id",
        [runId, staffId],
      )
    ).rows[0].id;
    const expenseId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO expenses(shift_id,voucher_number,category,payee_text,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,created_by) VALUES($1,'SYN-VCH-PAYROLL-1','salary','SYN PR Staff',10000,'YER',1,10000,'YER',$2) RETURNING id",
        [ids.shiftId, ACCOUNTS.owner.username],
      )
    ).rows[0].id;

    const exactFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          itemId,
          total: 10000,
          components: null,
          method: "cash",
          reference: "REF-1",
          notes: "SYN note",
          actorId: fx.ids.owner,
        }),
      )
      .digest("hex");

    await fx.pool.query(
      `INSERT INTO hr_payroll_disbursements(item_id,staff_id,currency,amount_minor,payment_method,reference_number,expense_id,disbursed_by,notes,client_request_id,request_fingerprint)
       VALUES($1,$2,'YER',10000,'cash','REF-1',$3,$4,'SYN note','pr-disb-key-0001',$5)`,
      [itemId, staffId, expenseId, ACCOUNTS.owner.username, exactFingerprint],
    );

    const matched = await hrPayroll.replayDisbursementForActor(
      fx.pool,
      itemId,
      { amountMinor: 10000, paymentMethod: "cash", referenceNumber: "REF-1", notes: "SYN note", clientRequestId: "pr-disb-key-0001" },
      fx.ids.owner,
    );
    expect(matched?.replayed).toBe(true);
    expect(matched?.amountMinor).toBe(10000);

    await expect(
      hrPayroll.replayDisbursementForActor(
        fx.pool,
        itemId,
        { amountMinor: 25000, paymentMethod: "cash", referenceNumber: "REF-1", notes: "SYN note", clientRequestId: "pr-disb-key-0001" },
        fx.ids.owner,
      ),
    ).rejects.toMatchObject({ code: "key_conflict" });

    await expect(
      hrPayroll.replayDisbursementForActor(
        fx.pool,
        itemId,
        { amountMinor: 10000, paymentMethod: "cash", referenceNumber: "REF-1", notes: "SYN note", clientRequestId: "pr-disb-key-0001" },
        fx.ids.adminNonOwner,
      ),
    ).rejects.toMatchObject({ code: "key_conflict" });
  });
});

describe("Finding 9 — non-owner admin is never elevated to principal owner", () => {
  it("denies paper-archive patient number override and payroll self-approval to non-owner admin", async () => {
    const pRow = (
      await fx.pool.query<{ id: number; patient_number: string; patient_number_version: string }>(
        "INSERT INTO patients(patient_number,full_name) VALUES('P-009500','SYN Paper Test') RETURNING id, patient_number, patient_number_version::text",
      )
    ).rows[0];

    await expect(
      endoVisits.changeCanonicalPatientNumber(
        await fx.session("adminNonOwner"),
        pRow.id,
        {
          patientNumber: "P-000123",
          expectedVersion: pRow.patient_number_version,
          expectedPatientNumber: pRow.patient_number,
          reason: "اختبار منع انتحال صلاحية المالك",
          allowPaperArchiveOverride: true,
        },
        wide,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    // Payroll self-approval by non-owner admin who created the run is refused (self_approval_forbidden)
    const periodId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO hr_payroll_periods(period_key,name,start_date,end_date,status,created_by) VALUES('2026-11','SYN Nov 2026','2026-11-01','2026-11-30','calculated',$1) RETURNING id",
        [ACCOUNTS.adminNonOwner.username],
      )
    ).rows[0].id;
    const draftRunId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO hr_payroll_runs(period_id,status,currency,created_by) VALUES($1,'draft','YER',$2) RETURNING id",
        [periodId, ACCOUNTS.adminNonOwner.username],
      )
    ).rows[0].id;

    const client = await wide.connect();
    try {
      await client.query("BEGIN");
      await expect(
        hrPayroll.approvePayrollRunInTx(client, draftRunId, {
          userId: fx.ids.adminNonOwner,
          username: ACCOUNTS.adminNonOwner.username,
          role: "admin",
          isOwner: false,
        }),
      ).rejects.toMatchObject({ code: "self_approval_forbidden", status: 403 });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

describe("Independent Finding 12a & 12b — ordered row locks on patient merge + net settlement check on lab cancel", () => {
  it("12a: mergeCanonicalPatient evaluates doctor scope AFTER waiting on FOR UPDATE patient locks", async () => {
    const targetId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-MRG-T1','SYN Merge Target',$1) RETURNING id",
        [fx.parties.doctorOwn!],
      )
    ).rows[0].id;
    const dupId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-MRG-D1','SYN Merge Dup',$1) RETURNING id",
        [fx.parties.doctorOwn!],
      )
    ).rows[0].id;

    const blocker = await wide.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM patients WHERE id = $1 FOR UPDATE", [dupId]);

      const mergePromise = endoVisits.mergeCanonicalPatient(
        await fx.session("doctorOwn"),
        targetId,
        {
          duplicatePatientNumber: "SYN-MRG-D1",
          confirmDuplicateNumber: "SYN-MRG-D1",
          reason: "اختبار نقل الملكية المتزامن",
        },
        wide,
      );

      await new Promise((r) => setTimeout(r, 200));
      await blocker.query("UPDATE patients SET primary_doctor_id = NULL WHERE id = $1", [dupId]);
      await blocker.query("COMMIT");

      await expect(mergePromise).rejects.toMatchObject({ code: "duplicate_not_found", status: 404 });
      const stillExists = await fx.pool.query("SELECT 1 FROM patients WHERE id = $1", [dupId]);
      expect(stillExists.rows).toHaveLength(1);
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }
  });

  it("12b: setLabOrderStatusInTransaction refuses cancel on partial or reversed payable and marks paid only when 100% net settled", async () => {
    const labPartyId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO parties(name,kind,is_active) VALUES('SYN PR Dental Lab','lab',TRUE) RETURNING id",
      )
    ).rows[0].id;

    const makeOrderWithPayable = async (tag: string) => {
      const orderId = (
        await fx.pool.query<{ id: number }>(
          "INSERT INTO lab_orders(patient_id,party_id,lab_name,work_type,status,cost_minor,cost_currency,exchange_rate,base_amount_minor,due_date,financial_status) VALUES($1,$2,'SYN PR Dental Lab',$3,'received',10000,'YER',1,10000,CURRENT_DATE+2,'unpaid') RETURNING id",
          [ids.ownPatient, labPartyId, `Crown-${tag}`],
        )
      ).rows[0].id;
      const payableId = (
        await fx.pool.query<{ id: number }>(
          "INSERT INTO payables(party_id,category,description,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,lab_order_id,due_date,created_by) VALUES($1,'lab',$2,10000,'YER',1,10000,'YER',$3,CURRENT_DATE+2,'syn') RETURNING id",
          [labPartyId, `Crown-${tag}`, orderId],
        )
      ).rows[0].id;
      await fx.pool.query("UPDATE lab_orders SET payable_id = $2 WHERE id = $1", [orderId, payableId]);
      return { orderId, payableId };
    };

    // Case 1: Partial payment (4,000 of 10,000) -> refused with lab_cancel_partial_payment_review
    const partial = await makeOrderWithPayable("partial");
    await fx.pool.query(
      "INSERT INTO expenses(shift_id,voucher_number,category,party_id,payee_text,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,payable_id,created_by) VALUES($3,'SYN-VCH-P1','lab',$1,'SYN Lab',4000,'YER',1,4000,'YER',$2,'syn')",
      [labPartyId, partial.payableId, ids.shiftId],
    );
    const c1 = await wide.connect();
    try {
      await c1.query("BEGIN");
      let caught: unknown;
      try {
        await db.setLabOrderStatusInTransaction(c1, partial.orderId, "cancelled", { actor: "syn", canCancelDispatched: true });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LabFinancialBoundaryError);
      expect((caught as { code: string }).code).toBe("lab_cancel_partial_payment_review");
      await c1.query("ROLLBACK");
    } finally {
      c1.release();
    }

    // Case 2: Paid 10,000 then reversed (-10,000) -> net 0 with paidCount > 0 -> refused!
    const reversed = await makeOrderWithPayable("reversed");
    const origExpId = (
      await fx.pool.query<{ id: number }>(
        "INSERT INTO expenses(shift_id,voucher_number,category,party_id,payee_text,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,payable_id,created_by) VALUES($3,'SYN-VCH-R1','lab',$1,'SYN Lab',10000,'YER',1,10000,'YER',$2,'syn') RETURNING id",
        [labPartyId, reversed.payableId, ids.shiftId],
      )
    ).rows[0].id;
    await fx.pool.query(
      "INSERT INTO expenses(shift_id,voucher_number,category,party_id,payee_text,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,payable_id,reversal_of_id,created_by) VALUES($4,'SYN-VCH-R2','lab',$1,'SYN Lab',-10000,'YER',1,-10000,'YER',$2,$3,'syn')",
      [labPartyId, reversed.payableId, origExpId, ids.shiftId],
    );
    const c2 = await wide.connect();
    try {
      await c2.query("BEGIN");
      await expect(
        db.setLabOrderStatusInTransaction(c2, reversed.orderId, "cancelled", { actor: "syn", canCancelDispatched: true }),
      ).rejects.toMatchObject({ code: "lab_cancel_partial_payment_review" });
      await c2.query("ROLLBACK");
    } finally {
      c2.release();
    }

    // Case 3: Fully settled net 10,000 -> cancel marks financial_status = 'paid'
    const settled = await makeOrderWithPayable("settled");
    await fx.pool.query(
      "INSERT INTO expenses(shift_id,voucher_number,category,party_id,payee_text,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,payable_id,created_by) VALUES($3,'SYN-VCH-S1','lab',$1,'SYN Lab',10000,'YER',1,10000,'YER',$2,'syn')",
      [labPartyId, settled.payableId, ids.shiftId],
    );
    const c3 = await wide.connect();
    try {
      await c3.query("BEGIN");
      const cancelled = await db.setLabOrderStatusInTransaction(c3, settled.orderId, "cancelled", { actor: "syn", canCancelDispatched: true });
      await c3.query("COMMIT");
      expect(cancelled?.status).toBe("cancelled");
      const { rows: [st] } = await fx.pool.query<{ financial_status: string }>("SELECT financial_status FROM lab_orders WHERE id = $1", [settled.orderId]);
      expect(st.financial_status).toBe("paid");
    } finally {
      c3.release();
    }

    // Case 4: Unpaid payable -> cancel deletes payable and marks exempt
    const unpaid = await makeOrderWithPayable("unpaid");
    const c4 = await wide.connect();
    try {
      await c4.query("BEGIN");
      const cancelled = await db.setLabOrderStatusInTransaction(c4, unpaid.orderId, "cancelled", { actor: "syn", canCancelDispatched: true });
      await c4.query("COMMIT");
      expect(cancelled?.status).toBe("cancelled");
      const { rows: [st] } = await fx.pool.query<{ financial_status: string; payable_id: number | null }>(
        "SELECT financial_status, payable_id FROM lab_orders WHERE id = $1",
        [unpaid.orderId],
      );
      expect(st).toEqual({ financial_status: "exempt", payable_id: null });
    } finally {
      c4.release();
    }
  });
});

describe("Finding 4 / independent 6 (legacy mode) — revokeLegacySessionIfCurrent never revokes newer sessions from a stale token", () => {
  it("revokes once when credentialVersion matches, then no-ops on replay so a newer session stays valid", async () => {
    const prevUrl = process.env.DATABASE_URL!;
    const legacyOwned = await openBackupTimestampFixture({ ...process.env });
    try {
      vi.stubEnv("DATABASE_URL", legacyOwned.source.options.connectionString!);
      await db.resetPoolForTesting();
      await db.ensureSchema();

      const pwHash = await authMod.hashPassword("SyntheticPass#2026!");
      const { rows: [u] } = await legacyOwned.source.query<{ id: number }>(
        "INSERT INTO users(username,display_name,password_hash,role,is_active,session_version) VALUES('SYN-LEGACY-USER','SYN Legacy Reception',$1,'reception',TRUE,0) RETURNING id",
        [pwHash],
      );

      const oldPayload = {
        userId: u.id,
        username: "SYN-LEGACY-USER",
        role: "reception",
        expiresAt: Date.now() + 60_000,
        credentialVersion: authMod.sessionCredentialVersion(pwHash, 0),
      };

      expect(await db.revokeLegacySessionIfCurrent(oldPayload)).toBe(true);
      const { rows: [afterFirst] } = await legacyOwned.source.query<{ session_version: number }>(
        "SELECT session_version FROM users WHERE id = $1",
        [u.id],
      );
      expect(afterFirst.session_version).toBe(1);

      // Replaying logout with the already-revoked v0 token MUST NOT bump session_version to 2!
      expect(await db.revokeLegacySessionIfCurrent(oldPayload)).toBe(false);
      const { rows: [afterReplay] } = await legacyOwned.source.query<{ session_version: number }>(
        "SELECT session_version FROM users WHERE id = $1",
        [u.id],
      );
      expect(afterReplay.session_version).toBe(1);
    } finally {
      vi.stubEnv("DATABASE_URL", prevUrl);
      await db.resetPoolForTesting();
      await legacyOwned.close();
    }
  });
});
