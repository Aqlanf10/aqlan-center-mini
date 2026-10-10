import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { REQUIRED_LANDMARKS } from "../../lib/ceph";
import type { CephWriteAuthorizer, DbClient } from "../../lib/db";

/**
 * Real PostgreSQL, synthetic fixtures only. Every race observes the exact writer
 * backend, its expected SQL, and its pg_blocking_pids edge. No global waiter
 * counts, fixed sleeps, mocked SQL, application startup, or external AI calls.
 */
assertRealPostgresUrl();
stubPostgresEnv();
process.env.DB_POOL_MAX = "10";

const db = await import("../../lib/db");
const { cephWriteAuthorizer } = await import("../../lib/ceph-link-authority");
const { sessionCredentialVersion } = await import("../../lib/auth");
const {
  ensureSchema, getPool, resetPoolForTesting, createCephAnalysis, updateCephCalibration,
  updateCephLandmarks, updateCephDiagnosis, completeCephAnalysis, discardCephAnalysis,
  duplicateCephAnalysis, mergeDuplicatePatient, createOrthoCase, linkCephStudyToCase,
} = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

const FAR_FUTURE = 4_102_444_800_000;
const accounts = new Map<string, { id: number; hash: string }>();
const sessionOf = (username: string, role: string, expiresAt = FAR_FUTURE) => {
  const account = accounts.get(username);
  return { username, role, expiresAt, userId: account?.id ?? 999_999,
    credentialVersion: sessionCredentialVersion(account?.hash ?? "unknown") };
};
const admin = () => cephWriteAuthorizer(sessionOf("m-admin", "admin"));
const doctor = () => cephWriteAuthorizer(sessionOf("m-doctor", "doctor"));
let doctorParty = 0;
let targetDoctorParty = 0;
let probe: Client;
let fixture = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  doctorParty = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'Synthetic Source Doctor') RETURNING id`))[0].id;
  targetDoctorParty = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'Synthetic Target Doctor') RETURNING id`))[0].id;
  await q(`INSERT INTO users (username, display_name, password_hash, role, party_id, permissions) VALUES
    ('m-admin', 'm-admin', 'x', 'admin', NULL, NULL),
    ('m-doctor', 'm-doctor', 'x', 'doctor', $1, '{"canUploadXrays":true,"canViewXrays":true}'),
    ('m-target-doctor', 'm-target-doctor', 'x', 'doctor', $2, '{"canUploadXrays":true,"canViewXrays":true}')`,
  [doctorParty, targetDoctorParty]);
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
const owned = async (label: string) => {
  const id = await newPatient(label);
  await q(`UPDATE patients SET primary_doctor_id = $2 WHERE id = $1`, [id, doctorParty]);
  return id;
};

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

/** Primary-doctor ownership is not moved to the target by patient merge. */
async function pair(label: string) {
  const source = await owned(`${label} source`);
  const target = await newPatient(`${label} target`);
  await q(`UPDATE patients SET primary_doctor_id = $2 WHERE id = $1`, [target, targetDoctorParty]);
  return { source, target };
}
const rowOf = async (id: number) => (await q<{ patient_id: number; status: string }>(
  `SELECT patient_id, status FROM ceph_analyses WHERE id = $1`, [id]))[0];
const draftsOf = async (patientId: number) => (await q<{ n: number }>(
  `SELECT COUNT(*)::int AS n FROM ceph_analyses WHERE patient_id = $1 AND status = 'draft'`, [patientId]))[0].n;
const mergeCtx = { actor: "m-admin", actorRole: "admin", reason: "synthetic merge-safety test" };

/** Everything clinical must remain byte-for-byte equivalent on refusal, including stamps. */
async function clinicalSnapshot(id: number) {
  return {
    analysis: (await q(`SELECT to_jsonb(a) - 'patient_id' AS row FROM ceph_analyses a WHERE id = $1`, [id]))[0],
    landmarks: await q(`SELECT * FROM ceph_landmarks WHERE analysis_id = $1 ORDER BY code`, [id]),
    measurements: await q(`SELECT * FROM ceph_measurements WHERE analysis_id = $1 ORDER BY code`, [id]),
    diagnoses: await q(`SELECT * FROM ceph_diagnoses WHERE analysis_id = $1 ORDER BY analysis_id`, [id]),
    audits: await q(`SELECT * FROM audit_log WHERE entity = 'ceph_analysis' AND entity_id = $1::text ORDER BY id`, [id]),
  };
}

const cephAudits = () => q(`SELECT * FROM audit_log WHERE action LIKE 'ceph.%' ORDER BY id`);

const compact = (sql: string) => sql.replace(/\s+/g, " ").trim();
const patientLock = /^SELECT id FROM patients WHERE id = \$1 FOR KEY SHARE$/;
const studyLock = /^SELECT .+ FROM ceph_analyses WHERE id = \$1 FOR UPDATE$/;
const mergeStudyWrite = /^UPDATE ceph_analyses SET patient_id = \$1 WHERE patient_id = \$2$/;
const mergePatientLock = /^SELECT .+ FROM patients WHERE id = ANY\(\$1::int\[\]\) ORDER BY id FOR UPDATE$/;
const createInsert = /^INSERT INTO ceph_analyses \(patient_id, document_id,/;
const accountRead = /^SELECT \* FROM users WHERE LOWER\(username\) = LOWER\(\$1\) AND is_active LIMIT 1 FOR SHARE$/;

async function waitForBlocked(writerPid: number, blockerPid: number, sql: RegExp) {
  await expect.poll(async () => {
    const { rows: [row] } = await probe.query<{ query: string; wait_event_type: string | null; blockers: number[] }>(
      `SELECT query, wait_event_type, pg_blocking_pids(pid) AS blockers
         FROM pg_stat_activity WHERE datname = current_database() AND pid = $1`, [writerPid]);
    return !!row && row.wait_event_type === "Lock" && row.blockers.includes(blockerPid) && sql.test(compact(row.query));
  }, { timeout: 10_000, interval: 25 }).toBe(true);
}

async function bounded<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: writers did not settle`)), 20_000);
    })]);
  } finally { clearTimeout(timer); }
}

type Tracked<T> = { pid: number; outcome: Promise<PromiseSettledResult<T>> };
async function value<T>(writer: Tracked<T>): Promise<T> {
  const outcome = await bounded(writer.outcome, `backend ${writer.pid}`);
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value;
}

type Held = { pid: number; client: DbClient; finish: (action: "COMMIT" | "ROLLBACK") => Promise<void> };
class Race {
  private held: Held[] = [];
  private pending: Promise<PromiseSettledResult<unknown>>[] = [];

  track<T>(pid: number, run: () => Promise<T>): Tracked<T> {
    // Attach both handlers immediately, before any lock assertion can fail.
    const outcome = Promise.resolve().then(run).then(
      (result): PromiseSettledResult<T> => ({ status: "fulfilled", value: result }),
      (reason): PromiseSettledResult<T> => ({ status: "rejected", reason }),
    );
    this.pending.push(outcome);
    return { pid, outcome };
  }

  async start<T>(run: () => Promise<T>): Promise<Tracked<T>> {
    const pool = getPool();
    const connect = pool.connect.bind(pool);
    let capture!: (pid: number) => void;
    const acquired = new Promise<number>((resolve) => { capture = resolve; });
    // Observe the next real acquisition; do not replace any SQL or transaction.
    // These suites are sequential, and observers/blockers have their own clients.
    const spy = vi.spyOn(pool, "connect").mockImplementationOnce((async () => {
      const client = await connect();
      try {
        capture((await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        return client;
      } catch (error) { client.release(); throw error; }
    }));
    const writer = this.track(0, run);
    try {
      writer.pid = await bounded(Promise.race([
        acquired,
        writer.outcome.then((outcome): never => {
          throw outcome.status === "rejected" ? outcome.reason : new Error("writer completed without acquiring a connection");
        }),
      ]), "connection acquisition");
      return writer;
    } finally { spy.mockRestore(); }
  }

  async hold(sql?: string, params: unknown[] = []): Promise<Held> {
    const client = await getPool().connect();
    let released = false;
    const held: Held = {
      pid: 0, client,
      finish: async (action) => {
        if (released) return;
        released = true;
        try { await client.query(action); }
        catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally { client.release(); }
      },
    };
    this.held.push(held);
    await client.query("BEGIN");
    held.pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    if (sql) await client.query(sql, params);
    return held;
  }

  async cleanup() {
    // Always unblock and release first, even if setup/polling/assertion failed.
    const releases = await Promise.allSettled(this.held.map((held) => held.finish("ROLLBACK")));
    await bounded(Promise.all(this.pending), "race cleanup");
    for (const release of releases) if (release.status === "rejected") throw release.reason;
  }
}
async function race(run: (scope: Race) => Promise<void>) {
  const scope = new Race();
  try { await run(scope); }
  finally { await scope.cleanup(); }
}

type WriteResult = { ok: boolean; status?: number; message?: string; id?: number };
type StudyWriter = {
  name: string;
  completed?: boolean;
  run: (id: number, authorize: CephWriteAuthorizer, by?: string) => Promise<WriteResult>;
};
const studyWriters: StudyWriter[] = [
  { name: "complete", run: (id, authorize, by = "m-doctor") => completeCephAnalysis(id, by, { authorize }) },
  { name: "discard", run: (id, authorize, by = "m-doctor") => discardCephAnalysis(id, by, "synthetic note", { authorize }) },
  { name: "duplicate", completed: true, run: (id, authorize, by = "m-doctor") => duplicateCephAnalysis(id, by, { authorize }) },
  { name: "calibration", run: (id, authorize, by = "m-doctor") => updateCephCalibration(id,
    { x1: 0, y1: 0, x2: 100, y2: 0, mm: 25 }, by, { authorize }) },
  { name: "landmarks", run: (id, authorize, by = "m-doctor") => updateCephLandmarks(id,
    [{ code: REQUIRED_LANDMARKS[0], x: 777, y: 888, source: "suggested" }], by, { authorize }) },
  { name: "diagnosis", run: (id, authorize, by = "m-doctor") => updateCephDiagnosis(id,
    { finalDx: "Synthetic authorized revision", note: "Synthetic local suggestion" }, by, { authorize }) },
];
async function prepareStudy(writer: StudyWriter, patientId: number) {
  const id = await completableDraft(patientId);
  if (writer.completed) expect((await completeCephAnalysis(id, "m-admin", { authorize: admin() })).ok).toBe(true);
  return id;
}
async function expectWritten(writer: StudyWriter, id: number, result: WriteResult) {
  expect(result.ok).toBe(true);
  if (writer.name === "complete") {
    expect((await rowOf(id)).status).toBe("completed");
    expect((await clinicalSnapshot(id)).measurements.length).toBeGreaterThan(0);
  } else if (writer.name === "discard") expect((await rowOf(id)).status).toBe("discarded");
  else if (writer.name === "duplicate") {
    expect(result.id).toEqual(expect.any(Number));
    expect((await rowOf(result.id!)).status).toBe("draft");
    expect((await q(`SELECT corrects_analysis_id::int AS corrects_analysis_id FROM ceph_analyses WHERE id = $1`, [result.id]))[0])
      .toMatchObject({ corrects_analysis_id: id });
  } else if (writer.name === "calibration") {
    expect((await q(`SELECT mm_per_pixel FROM ceph_analyses WHERE id = $1`, [id]))[0]).toEqual({ mm_per_pixel: 0.25 });
  } else if (writer.name === "landmarks") {
    expect((await q(`SELECT x, y, source FROM ceph_landmarks WHERE analysis_id = $1 AND code = $2`, [id, REQUIRED_LANDMARKS[0]]))[0])
      .toEqual({ x: 777, y: 888, source: "suggested" });
  } else {
    expect((await q(`SELECT final_dx FROM ceph_diagnoses WHERE analysis_id = $1`, [id]))[0])
      .toEqual({ final_dx: "Synthetic authorized revision" });
  }
}

describe("Ceph create versus real patient merge", () => {
  it("merge first: create waits on that merge, then refuses a second target draft without deadlock", async () => {
    const { source, target } = await pair("merge first");
    const sourceDraft = await completableDraft(source);
    const targetDocument = await newDocument(target);
    const beforeAudits = await cephAudits();
    await race(async (scope) => {
      const parked = await scope.hold(`SELECT id FROM ceph_analyses WHERE id = $1 FOR UPDATE`, [sourceDraft]);
      const merge = await scope.start(() => mergeDuplicatePatient(source, target, mergeCtx));
      await waitForBlocked(merge.pid, parked.pid, mergeStudyWrite);
      const create = await scope.start(() => createCephAnalysis({ patientId: target, documentId: targetDocument,
        createdBy: "m-admin", phase: "pretreatment", authorize: admin() }));
      await waitForBlocked(create.pid, merge.pid, patientLock);
      await parked.finish("ROLLBACK");
      expect(await value(merge)).toMatchObject({ ok: true });
      expect(await value(create)).toMatchObject({ ok: false, message: expect.stringMatching(/[؀-ۿ]/) });
    });
    expect(await draftsOf(target)).toBe(1);
    expect(await cephAudits()).toEqual(beforeAudits);
    expect((await rowOf(sourceDraft)).patient_id).toBe(target);
  });

  it("create first: the merge waits on that create and rolls back the conflicting move", async () => {
    const { source, target } = await pair("create first");
    const sourceDraft = await completableDraft(source);
    const before = await clinicalSnapshot(sourceDraft);
    const targetDocument = await newDocument(target);
    await race(async (scope) => {
      const parked = await scope.hold(`SELECT id FROM patient_documents WHERE id = $1 FOR UPDATE`, [targetDocument]);
      const create = await scope.start(() => createCephAnalysis({ patientId: target, documentId: targetDocument,
        createdBy: "m-admin", phase: "pretreatment", authorize: admin() }));
      await waitForBlocked(create.pid, parked.pid, createInsert);
      const merge = await scope.start(() => mergeDuplicatePatient(source, target, mergeCtx));
      await waitForBlocked(merge.pid, create.pid, mergePatientLock);
      await parked.finish("ROLLBACK");
      expect(await value(create)).toMatchObject({ ok: true });
      expect(await value(merge)).toMatchObject({ ok: false, reason: "conflict" });
    });
    expect(await draftsOf(target)).toBe(1);
    expect(await rowOf(sourceDraft)).toEqual({ patient_id: source, status: "draft" });
    expect(await clinicalSnapshot(sourceDraft)).toEqual(before);
  });
});

describe.each(studyWriters)("$name: current patient authority and merge serialization", (writer) => {
  it("denies the source-only doctor after a real merge, without changing any clinical row", async () => {
    const { source, target } = await pair(`${writer.name} denied after merge`);
    const id = await prepareStudy(writer, source);
    const before = await clinicalSnapshot(id);
    await race(async (scope) => {
      const parked = await scope.hold(`SELECT id FROM ceph_analyses WHERE id = $1 FOR UPDATE`, [id]);
      const merge = await scope.start(() => mergeDuplicatePatient(source, target, mergeCtx));
      await waitForBlocked(merge.pid, parked.pid, mergeStudyWrite);
      const write = await scope.start(() => writer.run(id, doctor()));
      await waitForBlocked(write.pid, merge.pid, patientLock);
      await parked.finish("ROLLBACK");
      expect(await value(merge)).toMatchObject({ ok: true });
      expect(await value(write)).toMatchObject({ ok: false, status: 403, message: expect.stringMatching(/[؀-ۿ]/) });
    });
    expect((await rowOf(id)).patient_id).toBe(target);
    expect(await q(`SELECT id FROM patients WHERE id = $1`, [source])).toHaveLength(0);
    expect(await clinicalSnapshot(id)).toEqual(before);
    expect(await draftsOf(target)).toBe(writer.completed ? 0 : 1);
  });

  it("allows the target-only doctor once the real merge finishes", async () => {
    const { source, target } = await pair(`${writer.name} target authority`);
    const id = await prepareStudy(writer, source);
    const before = await clinicalSnapshot(id);
    await race(async (scope) => {
      const parked = await scope.hold(`SELECT id FROM ceph_analyses WHERE id = $1 FOR UPDATE`, [id]);
      const merge = await scope.start(() => mergeDuplicatePatient(source, target, mergeCtx));
      await waitForBlocked(merge.pid, parked.pid, mergeStudyWrite);
      const write = await scope.start(() => writer.run(id,
        cephWriteAuthorizer(sessionOf("m-target-doctor", "doctor")), "m-target-doctor"));
      await waitForBlocked(write.pid, merge.pid, patientLock);
      await parked.finish("ROLLBACK");
      expect(await value(merge)).toMatchObject({ ok: true });
      await expectWritten(writer, id, await value(write));
    });
    expect((await rowOf(id)).patient_id).toBe(target);
    if (writer.completed) expect(await clinicalSnapshot(id)).toEqual(before);
  });

  it("writer first: the merge waits on the writer's parent lock and both complete", async () => {
    const { source, target } = await pair(`${writer.name} writer first`);
    const id = await prepareStudy(writer, source);
    await race(async (scope) => {
      const parked = await scope.hold(`SELECT id FROM ceph_analyses WHERE id = $1 FOR UPDATE`, [id]);
      const write = await scope.start(() => writer.run(id, doctor()));
      await waitForBlocked(write.pid, parked.pid, studyLock);
      const merge = await scope.start(() => mergeDuplicatePatient(source, target, mergeCtx));
      await waitForBlocked(merge.pid, write.pid, mergePatientLock);
      await parked.finish("ROLLBACK");
      const result = await value(write);
      expect(await value(merge)).toMatchObject({ ok: true });
      await expectWritten(writer, id, result);
    });
    expect((await rowOf(id)).patient_id).toBe(target);
  });
});

type PreparedWriter = { patientId: number; id?: number; run: (authorize: CephWriteAuthorizer) => Promise<WriteResult>;
  park: (scope: Race) => Promise<Held>; blockedQuery: RegExp; expectSuccess: (result: WriteResult) => Promise<void> };
const allWriters = ["create", ...studyWriters.map((writer) => writer.name)];
async function prepareWriter(name: string): Promise<PreparedWriter> {
  const patientId = await owned(`${name} protected account`);
  if (name === "create") {
    const documentId = await newDocument(patientId);
    return {
      patientId,
      run: (authorize) => createCephAnalysis({ patientId, documentId, createdBy: "m-doctor", phase: "pretreatment", authorize }),
      park: (scope) => scope.hold(`SELECT id FROM patient_documents WHERE id = $1 FOR UPDATE`, [documentId]),
      blockedQuery: createInsert,
      expectSuccess: async (result) => { expect(result.ok).toBe(true); expect(await draftsOf(patientId)).toBe(1); },
    };
  }
  const writer = studyWriters.find((entry) => entry.name === name)!;
  const id = await prepareStudy(writer, patientId);
  return { patientId, id,
    run: (authorize) => writer.run(id, authorize),
    park: (scope) => scope.hold(`SELECT id FROM ceph_analyses WHERE id = $1 FOR UPDATE`, [id]),
    blockedQuery: studyLock,
    expectSuccess: (result) => expectWritten(writer, id, result),
  };
}
const revocations = [
  { name: "credential version", sql: `UPDATE users SET password_hash = 'changed-after-login' WHERE username = 'm-doctor'` },
  { name: "canUploadXrays", sql: `UPDATE users SET permissions = '{"canUploadXrays":false,"canViewXrays":true}' WHERE username = 'm-doctor'` },
];
const restoreDoctor = () => q(`UPDATE users SET password_hash = 'x', permissions = '{"canUploadXrays":true,"canViewXrays":true}' WHERE username = 'm-doctor'`);

// The existing AI save branches use the same landmark/diagnosis helpers; their
// route-level wiring is covered in ceph-write-routes-authority.test.ts.
describe.each(allWriters)("%s: current credentials, permission and session expiry", (name) => {
  it.each(revocations)("$name committed before the protected read denies without partial writes", async (revocation) => {
    const prepared = await prepareWriter(name);
    const before = prepared.id == null ? await cephAudits() : await clinicalSnapshot(prepared.id);
    try {
      await race(async (scope) => {
        const changer = await scope.hold(revocation.sql);
        const write = await scope.start(() => prepared.run(doctor()));
        await waitForBlocked(write.pid, changer.pid, accountRead);
        await changer.finish("COMMIT");
        expect(await value(write)).toMatchObject({ ok: false, status: 403, message: expect.stringMatching(/[؀-ۿ]/) });
      });
      if (prepared.id == null) {
        expect(await draftsOf(prepared.patientId)).toBe(0);
        expect(await cephAudits()).toEqual(before);
      }
      else expect(await clinicalSnapshot(prepared.id)).toEqual(before);
    } finally { await restoreDoctor(); }
  });

  it.each(revocations)("the writer's protected read wins before $name; revocation waits until the write commits", async (revocation) => {
    const prepared = await prepareWriter(name);
    try {
      await race(async (scope) => {
        const parked = await prepared.park(scope);
        const changer = await scope.hold();
        const write = await scope.start(() => prepared.run(doctor()));
        await waitForBlocked(write.pid, parked.pid, prepared.blockedQuery);
        const revoke = scope.track(changer.pid, () => changer.client.query(revocation.sql));
        await waitForBlocked(revoke.pid, write.pid, new RegExp(`^${compact(revocation.sql).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
        await parked.finish("ROLLBACK");
        const result = await value(write);
        await value(revoke);
        await changer.finish("COMMIT");
        await prepared.expectSuccess(result);
      });
    } finally { await restoreDoctor(); }
  });

  it("a session that expires after authorization while blocked on the child row cannot commit", async () => {
    const prepared = await prepareWriter(name);
    const before = prepared.id == null ? await cephAudits() : await clinicalSnapshot(prepared.id);
    const expiresAt = Date.now() + 60_000;
    await race(async (scope) => {
      const parked = await prepared.park(scope);
      const write = await scope.start(() => prepared.run(cephWriteAuthorizer(sessionOf("m-doctor", "doctor", expiresAt))));
      await waitForBlocked(write.pid, parked.pid, prepared.blockedQuery);
      // Move only the wall clock after proving that real account/patient checks
      // already passed. PostgreSQL and Vitest timers keep running normally.
      const clock = vi.spyOn(Date, "now").mockReturnValue(expiresAt + 1);
      try {
        await parked.finish("ROLLBACK");
        expect(await value(write)).toMatchObject({ ok: false, status: 403 });
      } finally { clock.mockRestore(); }
    });
    if (prepared.id == null) {
      expect(await draftsOf(prepared.patientId)).toBe(0);
      expect(await cephAudits()).toEqual(before);
    }
    else expect(await clinicalSnapshot(prepared.id)).toEqual(before);
  });
});

describe("Ceph completed-study integrity", () => {
  it.each(studyWriters.filter((writer) => !writer.completed))("$name cannot mutate a completed study or its stamped children", async (writer) => {
    const patientId = await owned(`${writer.name} completed`);
    const id = await completableDraft(patientId);
    expect((await completeCephAnalysis(id, "m-admin", { authorize: admin() })).ok).toBe(true);
    const before = await clinicalSnapshot(id);
    expect(await writer.run(id, doctor())).toMatchObject({ ok: false });
    expect(await clinicalSnapshot(id)).toEqual(before);
  });
});

describe("Ceph rollback and pooled-connection hygiene", () => {
  it.each(allWriters)("%s rolls back a throwing authorizer and returns the exact pooled connection clean", async (name) => {
    const prepared = await prepareWriter(name);
    const before = prepared.id == null ? await cephAudits() : await clinicalSnapshot(prepared.id);
    const message = `synthetic ${name} authorizer failure`;
    await race(async (scope) => {
      const write = await scope.start(() => prepared.run(async (client) => {
        await client.query(`UPDATE patients SET note = $2 WHERE id = $1`, [prepared.patientId, "synthetic doomed authorization"]);
        throw new Error(message);
      }));
      const outcome = await bounded(write.outcome, "throwing authorizer");
      expect(outcome).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message }) });
      // Pool idle order should return the just-released connection. Acquire it
      // before assertions so even the buggy implementation is cleaned in finally.
      const reused = await getPool().connect();
      try {
        const { rows: [activity] } = await probe.query<{ state: string; query: string }>(
          `SELECT state, query FROM pg_stat_activity WHERE pid = $1`, [write.pid]);
        expect(activity.state).toBe("idle");
        expect(compact(activity.query)).toBe("ROLLBACK");
        const { rows: [identity] } = await reused.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        expect(identity.pid).toBe(write.pid);
        await reused.query("BEGIN");
        expect((await reused.query(`SELECT note FROM patients WHERE id = $1`, [prepared.patientId])).rows[0]).toEqual({ note: null });
        await reused.query("COMMIT");
      } finally {
        await reused.query("ROLLBACK").catch(() => {});
        reused.release();
      }
    });
    expect((await q(`SELECT note FROM patients WHERE id = $1`, [prepared.patientId]))[0]).toEqual({ note: null });
    if (prepared.id == null) {
      expect(await draftsOf(prepared.patientId)).toBe(0);
      expect(await cephAudits()).toEqual(before);
    }
    else expect(await clinicalSnapshot(prepared.id)).toEqual(before);
    await prepared.expectSuccess(await prepared.run(doctor()));
  });

  it("a measurement-stamping exception rolls back approval and a subsequent approval works", async () => {
    const id = await completableDraft(await owned("stamp failure"));
    const before = await clinicalSnapshot(id);
    await q(`CREATE OR REPLACE FUNCTION ceph_ms_fail_stamp() RETURNS TRIGGER AS $f$ BEGIN RAISE EXCEPTION 'synthetic stamp failure'; END $f$ LANGUAGE plpgsql`);
    try {
      await q(`CREATE TRIGGER ceph_ms_fail_stamp BEFORE INSERT ON ceph_measurements FOR EACH ROW EXECUTE FUNCTION ceph_ms_fail_stamp()`);
      try {
        await expect(completeCephAnalysis(id, "m-admin", { authorize: admin() })).rejects.toThrow(/synthetic stamp failure/);
      } finally { await q(`DROP TRIGGER IF EXISTS ceph_ms_fail_stamp ON ceph_measurements`); }
    } finally { await q(`DROP FUNCTION IF EXISTS ceph_ms_fail_stamp()`); }
    expect(await clinicalSnapshot(id)).toEqual(before);
    expect((await completeCephAnalysis(id, "m-admin", { authorize: admin() })).ok).toBe(true);
  });
});

describe("Ceph case-link expiry after child locks", () => {
  it.each(["study", "case"])("expires while waiting on the %s row without changing the study or audit", async (child) => {
    const patientId = await owned(`link expiry ${child}`);
    const id = await completableDraft(patientId);
    const createdCase = await createOrthoCase({
      patientId, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null, startDate: "2026-02-01",
      plannedMonths: 18, planId: null, note: null, createdBy: "merge-safety-test",
    });
    if (!createdCase.ok) throw new Error(createdCase.message);
    const caseId = createdCase.id;
    const before = await clinicalSnapshot(id);
    const expiresAt = Date.now() + 60_000;
    await race(async (scope) => {
      const parked = child === "study"
        ? await scope.hold(`SELECT id FROM ceph_analyses WHERE id = $1 FOR UPDATE`, [id])
        : await scope.hold(`SELECT id FROM ortho_cases WHERE id = $1 FOR UPDATE`, [caseId]);
      const write = await scope.start(() => linkCephStudyToCase({
        analysisId: id, orthoCaseId: caseId,
        expected: { phase: "during", xrayDate: "2026-03-14", status: "draft" },
        actor: "m-doctor", actorRole: "doctor",
        authorize: cephWriteAuthorizer(sessionOf("m-doctor", "doctor", expiresAt)),
      }));
      await waitForBlocked(write.pid, parked.pid, child === "study" ? studyLock
        : /^SELECT patient_id, status FROM ortho_cases WHERE id = \$1 FOR SHARE$/);
      const clock = vi.spyOn(Date, "now").mockReturnValue(expiresAt + 1);
      try {
        await parked.finish("ROLLBACK");
        expect(await value(write)).toMatchObject({ ok: false, status: 403 });
      } finally { clock.mockRestore(); }
    });
    expect(await clinicalSnapshot(id)).toEqual(before);
  });
});

describe("Ceph expiry after clinical writes but before commit", () => {
  /** Keep the real canonical credential/permission/patient locks. Only the pure
   * deadline hook changes: valid after the child lock, expired at final commit. */
  function expiresAtCommit() {
    const canonical = doctor();
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const authorize: CephWriteAuthorizer = Object.assign(
      (client: DbClient, patientId: number) => canonical(client, patientId), { isCurrent },
    );
    return { authorize, isCurrent };
  }

  it.each(studyWriters)("$name rolls back every clinical/audit change if the final expiry check fails", async (writer) => {
    const patientId = await owned(`${writer.name} final expiry`);
    const id = await prepareStudy(writer, patientId);
    const before = await clinicalSnapshot(id);
    const beforeAudits = await cephAudits();
    const { authorize, isCurrent } = expiresAtCommit();
    expect(await writer.run(id, authorize)).toMatchObject({ ok: false, status: 403 });
    expect(isCurrent).toHaveBeenCalledTimes(2);
    expect(await clinicalSnapshot(id)).toEqual(before);
    expect(await cephAudits()).toEqual(beforeAudits);
    // In particular, a correction's INSERT and transactional audit both rolled back.
    expect(await draftsOf(patientId)).toBe(writer.completed ? 0 : 1);
  });

  it("case linking rolls back its UPDATE and audit through the precommit expiry sentinel", async () => {
    const patientId = await owned("link final expiry");
    const id = await completableDraft(patientId);
    const createdCase = await createOrthoCase({
      patientId, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null, startDate: "2026-02-01",
      plannedMonths: 18, planId: null, note: null, createdBy: "merge-safety-test",
    });
    if (!createdCase.ok) throw new Error(createdCase.message);
    const before = await clinicalSnapshot(id);
    const beforeAudits = await cephAudits();
    const { authorize, isCurrent } = expiresAtCommit();
    expect(await linkCephStudyToCase({
      analysisId: id, orthoCaseId: createdCase.id,
      expected: { phase: "during", xrayDate: "2026-03-14", status: "draft" },
      actor: "m-doctor", actorRole: "doctor", authorize,
    })).toMatchObject({ ok: false, status: 403 });
    expect(isCurrent).toHaveBeenCalledTimes(2);
    expect(await clinicalSnapshot(id)).toEqual(before);
    expect(await cephAudits()).toEqual(beforeAudits);
  });
});
