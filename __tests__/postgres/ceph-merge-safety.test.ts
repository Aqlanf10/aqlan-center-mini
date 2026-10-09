import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { REQUIRED_LANDMARKS } from "../../lib/ceph";

/**
 * (ORTHO-ID-3) سلامة عمليات السيفالو عند دمج المرضى وتغيّر الصلاحيات — على PostgreSQL 18 معزول، بالدوال الحقيقية.
 *
 * 1) إنشاء دراسة بالتزامن مع `mergeDuplicatePatient` (مصدرٌ لديه مسودة، وهدفٌ بلا مسودة): قيد «مسودة واحدة لكل مريض»
 *    وقفل المريض والمفتاح الأجنبي، ببدء الدمج أولًا وببدء الإنشاء أولًا.
 * 2) اعتماد/رفض دراسة بطبيبٍ مخوّل للمريض المصدر وحده بينما ينتقل السجل بالدمج إلى مريضٍ لا يملك عليه صلاحية، وإبطال
 *    الجلسة أثناء الانتظار. التزامن بأقفالٍ محجوزة ومراقبة `pg_stat_activity` لا `sleep` ثابت.
 */

assertRealPostgresUrl();
stubPostgresEnv();
// Several connections are held at once (blockers + the writers under test).
process.env.DB_POOL_MAX = "10";

const db = await import("../../lib/db");
const { cephWriteAuthorizer } = await import("../../lib/ceph-link-authority");
const { sessionCredentialVersion } = await import("../../lib/auth");
const {
  ensureSchema, getPool, resetPoolForTesting, createCephAnalysis, updateCephCalibration, completeCephAnalysis,
  discardCephAnalysis, duplicateCephAnalysis, mergeDuplicatePatient,
} = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

const FAR_FUTURE = 4_102_444_800_000;
const accounts = new Map<string, { id: number; hash: string }>();
const sessionOf = (username: string, role: string) => {
  const account = accounts.get(username);
  return { username, role, expiresAt: FAR_FUTURE, userId: account?.id ?? 999_999, credentialVersion: sessionCredentialVersion(account?.hash ?? "unknown") };
};
let doctorParty = 0;
let probe: Client;
let fixture = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  doctorParty = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'Synthetic Doctor') RETURNING id`))[0].id;
  await q(`INSERT INTO users (username, display_name, password_hash, role, party_id, permissions) VALUES
    ('m-admin', 'm-admin', 'x', 'admin', NULL, NULL),
    ('m-doctor', 'm-doctor', 'x', 'doctor', $1, '{"canUploadXrays":true,"canViewXrays":true}')`, [doctorParty]);
  for (const row of await q<{ id: number; username: string; password_hash: string }>(`SELECT id, username, password_hash FROM users`)) {
    accounts.set(row.username, { id: row.id, hash: row.password_hash });
  }
  probe = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await probe.connect();
}, 180_000);
afterAll(async () => { await probe?.end(); await resetPoolForTesting(); });

const newPatient = async (label: string) => (await q<{ id: number }>(
  `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`,
  [`SYN-MS-${++fixture}`, `Synthetic ${label}`]))[0].id;
const newDocument = async (patientId: number) => (await q<{ id: number }>(
  `INSERT INTO patient_documents (patient_id, kind, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
   VALUES ($1, 'imaging', 'Synthetic image', 'image/jpeg', 1, $2, $3, 'merge-safety-test') RETURNING id`,
  [patientId, `sha-ms-${Math.random()}`, `synthetic/ms-${Math.random()}.jpg`]))[0].id;

/** مسودة جاهزة للاعتماد (معايرة + معالم كاملة) لم تُعتمد بعد. */
async function completableDraft(patientId: number) {
  const created = await createCephAnalysis({
    patientId, documentId: await newDocument(patientId), createdBy: "merge-safety-test", phase: "during", xrayDate: "2026-03-14",
  });
  if (!created.ok) throw new Error(created.message);
  const calibrated = await updateCephCalibration(created.id, { x1: 0, y1: 0, x2: 100, y2: 0, mm: 50 }, "merge-safety-test");
  if (!calibrated.ok) throw new Error(calibrated.message);
  for (const [index, code] of REQUIRED_LANDMARKS.entries()) {
    await q(`INSERT INTO ceph_landmarks (analysis_id, code, x, y, source, confirmed_by) VALUES ($1, $2, $3, $4, 'manual', 'merge-safety-test')`,
      [created.id, code, 40 + (index * 37) % 400, 30 + (index * 53) % 380]);
  }
  return Number(created.id);
}
/**
 * مريضا دمج بلا أثر مالي. الطبيب يملك المصدر وحده بتعيين «الطبيب الأساسي» — شاهدُ ملكيةٍ **لا ينتقل** بالدمج (يُحذف صفّ المصدر
 * ولا يُنسخ الطبيب الأساسي إلى الهدف). أما الزيارات والخطط فتنتقل مع المريض فيصير صاحبها مالكًا للهدف بقاعدة النظام نفسها،
 * وهذا ليس ما يُختبر هنا. الهدف له طبيبٌ أساسيٌّ آخر.
 */
async function pair(label: string) {
  const source = await newPatient(`${label} source`);
  const target = await newPatient(`${label} target`);
  const other = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'Synthetic Other Doctor') RETURNING id`))[0].id;
  await q(`UPDATE patients SET primary_doctor_id = $2 WHERE id = $1`, [source, doctorParty]);
  await q(`UPDATE patients SET primary_doctor_id = $2 WHERE id = $1`, [target, other]);
  return { source, target };
}
const rowOf = async (id: number) => (await q<{ patient_id: number; status: string }>(`SELECT patient_id, status FROM ceph_analyses WHERE id = $1`, [id]))[0];
const measurementsOf = async (id: number) => (await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ceph_measurements WHERE analysis_id = $1`, [id]))[0].n;
const draftsOf = async (patientId: number) => (await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ceph_analyses WHERE patient_id = $1 AND status = 'draft'`, [patientId]))[0].n;
const mergeCtx = { actor: "m-admin", actorRole: "admin", reason: "synthetic merge-safety test" };

const hold = async (sql: string, params: unknown[] = []) => {
  const client = await getPool().connect();
  await client.query("BEGIN");
  await client.query(sql, params);
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  return { pid, release: async (action: "COMMIT" | "ROLLBACK") => { await client.query(action); client.release(); } };
};
/** ينتظر حتى يبلغ عدد الاتصالات المنتظرة قفلًا العدد المطلوب — إثباتٌ للتزامن بلا sleep ثابت. */
async function waitForLockWaiters(count: number) {
  await expect.poll(async () => (await probe.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].n,
  { timeout: 10_000, interval: 25 }).toBeGreaterThanOrEqual(count);
}
const settled = async (...promises: Promise<unknown>[]) => {
  const result = await Promise.race([Promise.allSettled(promises), new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 20_000))]);
  if (result === "timeout") throw new Error("lock cycle: the writers did not finish");
  return result;
};
const asValue = <T,>(result: PromiseSettledResult<unknown>) => {
  if (result.status !== "fulfilled") throw new Error(`rejected: ${(result.reason as Error)?.message ?? result.reason}`);
  return result.value as T;
};

describe("(ORTHO-ID-3) createCephAnalysis × mergeDuplicatePatient (one draft per patient)", () => {
  it("merge starts first: the create waits behind the merge and then meets the single-draft rule — no deadlock, one draft", async () => {
    const { source, target } = await pair("create vs merge (merge first)");
    const sourceDraft = await completableDraft(source);
    const targetDocument = await newDocument(target);
    // Park the merge on the source draft row after it has locked both patients.
    const parked = await hold(`SELECT id FROM ceph_analyses WHERE id = $1 FOR UPDATE`, [sourceDraft]);
    const merge = mergeDuplicatePatient(source, target, mergeCtx);
    await waitForLockWaiters(1);
    const create = createCephAnalysis({
      patientId: target, documentId: targetDocument, createdBy: "m-doctor", phase: "pretreatment", xrayDate: "2026-04-01",
      authorize: cephWriteAuthorizer(sessionOf("m-admin", "admin")),
    });
    await waitForLockWaiters(2);
    await parked.release("ROLLBACK");

    const [mergeResult, createResult] = await settled(merge, create);
    expect(asValue<{ ok: boolean }>(mergeResult).ok).toBe(true);
    expect(asValue<{ ok: boolean; message?: string }>(createResult)).toMatchObject({ ok: false, message: expect.stringMatching(/[؀-ۿ]/) });
    expect(await draftsOf(target)).toBe(1);
    expect((await rowOf(sourceDraft)).patient_id).toBe(target);
  });

  it("create starts first: the merge waits for it and is refused as a conflict — source untouched, one draft on the target", async () => {
    const { source, target } = await pair("create vs merge (create first)");
    const sourceDraft = await completableDraft(source);
    const targetDocument = await newDocument(target);
    // Park the create inside its INSERT (it already holds the patient lock) by holding its document row.
    const parked = await hold(`SELECT id FROM patient_documents WHERE id = $1 FOR UPDATE`, [targetDocument]);
    const create = createCephAnalysis({
      patientId: target, documentId: targetDocument, createdBy: "m-doctor", phase: "pretreatment", xrayDate: "2026-04-01",
      authorize: cephWriteAuthorizer(sessionOf("m-admin", "admin")),
    });
    await waitForLockWaiters(1);
    const merge = mergeDuplicatePatient(source, target, mergeCtx);
    await waitForLockWaiters(2);
    await parked.release("ROLLBACK");

    const [createResult, mergeResult] = await settled(create, merge);
    expect(asValue<{ ok: boolean }>(createResult).ok).toBe(true);
    expect(asValue<{ ok: boolean; reason?: string }>(mergeResult)).toMatchObject({ ok: false, reason: "conflict" });
    expect(await draftsOf(target)).toBe(1);
    expect((await rowOf(sourceDraft)).patient_id).toBe(source); // the refused merge changed nothing
  });
});

describe("(ORTHO-ID-3) approve / discard × merge: the actor is authorized on the study's current patient", () => {
  const park = async (label: string) => {
    const { source, target } = await pair(label);
    const draft = await completableDraft(source);
    const parked = await hold(`SELECT id FROM ceph_analyses WHERE id = $1 FOR UPDATE`, [draft]);
    const merge = mergeDuplicatePatient(source, target, mergeCtx);
    await waitForLockWaiters(1);
    return { source, target, draft, parked, merge };
  };

  it("a doctor entitled to the SOURCE patient only cannot approve the record once the merge moved it to the target", async () => {
    const { target, draft, parked, merge } = await park("approve moved");
    const approve = completeCephAnalysis(draft, "m-doctor", { authorize: cephWriteAuthorizer(sessionOf("m-doctor", "doctor")) });
    await waitForLockWaiters(2);
    await parked.release("ROLLBACK");

    const [mergeResult, approveResult] = await settled(merge, approve);
    expect(asValue<{ ok: boolean }>(mergeResult).ok).toBe(true);
    expect(asValue<{ ok: boolean; message?: string }>(approveResult)).toMatchObject({ ok: false, message: expect.stringMatching(/[؀-ۿ]/) });
    // Refusal leaves no partial clinical change: still an unapproved draft with no stamped measurements.
    expect(await rowOf(draft)).toEqual({ patient_id: target, status: "draft" });
    expect(await measurementsOf(draft)).toBe(0);
  });

  it("the same doctor cannot discard it either", async () => {
    const { target, draft, parked, merge } = await park("discard moved");
    const discard = discardCephAnalysis(draft, "m-doctor", "synthetic note", { authorize: cephWriteAuthorizer(sessionOf("m-doctor", "doctor")) });
    await waitForLockWaiters(2);
    await parked.release("ROLLBACK");

    const [mergeResult, discardResult] = await settled(merge, discard);
    expect(asValue<{ ok: boolean }>(mergeResult).ok).toBe(true);
    expect(asValue<{ ok: boolean }>(discardResult).ok).toBe(false);
    expect(await rowOf(draft)).toEqual({ patient_id: target, status: "draft" });
  });

  it("the same doctor cannot open a correction of the moved, approved record either — nothing is created", async () => {
    const { source, target } = await pair("correct moved");
    const approved = await completableDraft(source);
    expect((await completeCephAnalysis(approved, "m-admin", { authorize: cephWriteAuthorizer(sessionOf("m-admin", "admin")) })).ok).toBe(true);
    const parked = await hold(`SELECT id FROM ceph_analyses WHERE id = $1 FOR UPDATE`, [approved]);
    const merge = mergeDuplicatePatient(source, target, mergeCtx);
    await waitForLockWaiters(1);
    const correction = duplicateCephAnalysis(approved, "m-doctor", { authorize: cephWriteAuthorizer(sessionOf("m-doctor", "doctor")) });
    await waitForLockWaiters(2);
    await parked.release("ROLLBACK");

    const [mergeResult, correctionResult] = await settled(merge, correction);
    expect(asValue<{ ok: boolean }>(mergeResult).ok).toBe(true);
    expect(asValue<{ ok: boolean }>(correctionResult).ok).toBe(false);
    expect(await draftsOf(target)).toBe(0);
  });

  it("an actor entitled to the target (admin) still approves after the merge — authority follows the current identity", async () => {
    const { target, draft, parked, merge } = await park("approve moved by admin");
    const approve = completeCephAnalysis(draft, "m-admin", { authorize: cephWriteAuthorizer(sessionOf("m-admin", "admin")) });
    await waitForLockWaiters(2);
    await parked.release("ROLLBACK");

    const [mergeResult, approveResult] = await settled(merge, approve);
    expect(asValue<{ ok: boolean }>(mergeResult).ok).toBe(true);
    expect(asValue<{ ok: boolean }>(approveResult).ok).toBe(true);
    expect(await rowOf(draft)).toEqual({ patient_id: target, status: "completed" });
    expect(await measurementsOf(draft)).toBeGreaterThan(0);
  });
});

describe("(ORTHO-ID-3) a session invalidated while the request waits is refused", () => {
  const changePassword = async () => hold(`UPDATE users SET password_hash = 'changed-after-login' WHERE username = 'm-doctor'`);
  const restore = () => q(`UPDATE users SET password_hash = 'x' WHERE username = 'm-doctor'`);
  const owned = async (label: string) => {
    const id = await newPatient(label);
    await q(`INSERT INTO visits (patient_name, patient_id, doctor_id, status) VALUES ('Synthetic', $1, $2, 'done')`, [id, doctorParty]);
    return id;
  };

  it("approve", async () => {
    const draft = await completableDraft(await owned("stale approve"));
    const session = sessionOf("m-doctor", "doctor");
    const changer = await changePassword();
    try {
      const pending = completeCephAnalysis(draft, "m-doctor", { authorize: cephWriteAuthorizer(session) });
      await waitForLockWaiters(1);
      await changer.release("COMMIT");
      expect(await pending).toMatchObject({ ok: false });
    } finally { await restore(); }
    expect((await rowOf(draft)).status).toBe("draft");
    expect(await measurementsOf(draft)).toBe(0);
  });

  it("discard", async () => {
    const draft = await completableDraft(await owned("stale discard"));
    const session = sessionOf("m-doctor", "doctor");
    const changer = await changePassword();
    try {
      const pending = discardCephAnalysis(draft, "m-doctor", null, { authorize: cephWriteAuthorizer(session) });
      await waitForLockWaiters(1);
      await changer.release("COMMIT");
      expect(await pending).toMatchObject({ ok: false });
    } finally { await restore(); }
    expect((await rowOf(draft)).status).toBe("draft");
  });

  it("create", async () => {
    const patientId = await owned("stale create");
    const documentId = await newDocument(patientId);
    const session = sessionOf("m-doctor", "doctor");
    const changer = await changePassword();
    try {
      const pending = createCephAnalysis({ patientId, documentId, createdBy: "m-doctor", phase: "pretreatment", authorize: cephWriteAuthorizer(session) });
      await waitForLockWaiters(1);
      await changer.release("COMMIT");
      expect(await pending).toMatchObject({ ok: false });
    } finally { await restore(); }
    expect(await draftsOf(patientId)).toBe(0);
  });
});

describe("(ORTHO-ID-3) transaction failure leaves nothing partial", () => {
  it("a failure while stamping the measurements rolls the approval back completely", async () => {
    const draft = await completableDraft(await newPatient("stamp failure"));
    await q(`CREATE OR REPLACE FUNCTION ceph_ms_fail_stamp() RETURNS TRIGGER AS $f$ BEGIN RAISE EXCEPTION 'synthetic stamp failure'; END $f$ LANGUAGE plpgsql`);
    await q(`CREATE TRIGGER ceph_ms_fail_stamp BEFORE INSERT ON ceph_measurements FOR EACH ROW EXECUTE FUNCTION ceph_ms_fail_stamp()`);
    try {
      await expect(completeCephAnalysis(draft, "m-admin", { authorize: cephWriteAuthorizer(sessionOf("m-admin", "admin")) })).rejects.toThrow(/synthetic stamp failure/);
    } finally {
      await q(`DROP TRIGGER ceph_ms_fail_stamp ON ceph_measurements`);
      await q(`DROP FUNCTION ceph_ms_fail_stamp()`);
    }
    expect((await rowOf(draft)).status).toBe("draft");
    expect(await measurementsOf(draft)).toBe(0);
    // The connection went back to the pool clean: the next write works.
    expect((await completeCephAnalysis(draft, "m-admin", { authorize: cephWriteAuthorizer(sessionOf("m-admin", "admin")) })).ok).toBe(true);
  });
});
