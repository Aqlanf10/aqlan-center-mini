/** Slice 30: Canonical Cephalometrics on real PostgreSQL 18 with synthetic records. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { REQUIRED_LANDMARKS, type LandmarkCode } from "../../lib/ceph";

vi.mock("server-only", () => ({}));
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-ceph-canonical-20261031-secret");

const db = await import("../../lib/db");
const ceph = await import("../../lib/canonical-ceph");
const { CANONICAL_RECORD_READS } = await import("../../lib/canonical-record-reads");

const FULL_CEPH = {
  "clinical.xrays.view": true,
  "clinical.xrays.upload": true,
  "clinical.ceph.analyze": true,
} as const;
const VIEW_ONLY = { "clinical.xrays.view": true } as const;
const UPLOAD_ONLY = { "clinical.xrays.view": true, "clinical.xrays.upload": true } as const;
const ANALYZE_ONLY = { "clinical.xrays.view": true, "clinical.ceph.analyze": true } as const;

const ACCOUNTS = {
  owner: { username: "SYN-CEPH-OWNER", role: "admin" },
  ownFull: { username: "SYN-CEPH-OWN", role: "doctor", doctor: true, patientScope: "own", grants: FULL_CEPH },
  allView: { username: "SYN-CEPH-ALL-VIEW", role: "reception", patientScope: "all", grants: VIEW_ONLY },
  ownUploadOnly: { username: "SYN-CEPH-UPLOAD", role: "doctor", doctor: true, patientScope: "own", grants: UPLOAD_ONLY },
  ownAnalyzeOnly: { username: "SYN-CEPH-ANALYZE", role: "doctor", doctor: true, patientScope: "own", grants: ANALYZE_ONLY },
  adjacent: { username: "SYN-CEPH-ADJ", role: "admin", patientScope: "all", grants: { "clinical.ortho.view": true } },
  noneScope: { username: "SYN-CEPH-NONE", role: "doctor", doctor: true, patientScope: "none", grants: FULL_CEPH },
  unlinked: { username: "SYN-CEPH-UNLINKED", role: "doctor", patientScope: "own", grants: FULL_CEPH },
} as const;

type Key = keyof typeof ACCOUNTS;

let fx: CanonicalInventoryDatabase<Key>;
let side: Pool;

const ids = {
  ownPatient: 0,
  foreignPatient: 0,
  ownDoc1: 0,
  ownDoc2: 0,
  ownPdfDoc: 0,
  foreignDoc: 0,
  foreignCompletedId: 0,
};

function syntheticLandmarks(shiftX = 0): { code: LandmarkCode; x: number; y: number; source: "manual" }[] {
  const coords: Partial<Record<LandmarkCode, [number, number]>> = {
    S: [120, 140],
    N: [260, 130],
    Or: [240, 175],
    Po: [95, 180],
    A: [258 + shiftX, 235],
    B: [244, 315],
    Pog: [248, 345],
    Gn: [244, 355],
    Me: [236, 360],
    Go: [130, 310],
    U1A: [250, 232],
    U1: [272, 270],
    L1A: [246, 312],
    L1: [266, 274],
    OcclA: [269, 272],
    OcclP: [204, 269],
  };
  return REQUIRED_LANDMARKS.map((code, idx) => {
    const [x, y] = coords[code] ?? [150 + idx * 7, 160 + idx * 6];
    return { code, x, y, source: "manual" as const };
  });
}

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  side = new Pool({ connectionString: fx.pool.options.connectionString, max: 3 });

  ids.ownPatient = (await fx.pool.query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-CEPH-P1','SYN Ceph Own',$1) RETURNING id",
    [fx.parties.ownFull!],
  )).rows[0].id;
  ids.foreignPatient = (await fx.pool.query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-CEPH-P2','SYN Ceph Foreign',NULL) RETURNING id",
  )).rows[0].id;

  ids.ownDoc1 = (await fx.pool.query<{ id: number }>(
    `INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,width,height)
     VALUES($1,'imaging','SYN T1 Ceph','image/jpeg',100,repeat('1',64),'synthetic/ceph-t1.jpg','SYN',1200,1000) RETURNING id`,
    [ids.ownPatient],
  )).rows[0].id;
  ids.ownDoc2 = (await fx.pool.query<{ id: number }>(
    `INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,width,height)
     VALUES($1,'imaging','SYN T2 Ceph','image/jpeg',100,repeat('2',64),'synthetic/ceph-t2.jpg','SYN',1200,1000) RETURNING id`,
    [ids.ownPatient],
  )).rows[0].id;
  ids.ownPdfDoc = (await fx.pool.query<{ id: number }>(
    `INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by)
     VALUES($1,'report','SYN Non-image','application/pdf',100,repeat('3',64),'synthetic/doc.pdf','SYN') RETURNING id`,
    [ids.ownPatient],
  )).rows[0].id;
  ids.foreignDoc = (await fx.pool.query<{ id: number }>(
    `INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,width,height)
     VALUES($1,'imaging','SYN Foreign Ceph','image/jpeg',100,repeat('4',64),'synthetic/ceph-foreign.jpg','SYN',1200,1000) RETURNING id`,
    [ids.foreignPatient],
  )).rows[0].id;

  // Seed synthetic reference set (SKIP_SEED=true skips ensureSchema demo seeding).
  const refSetId = Number((await fx.pool.query<{ id: string }>(
    `INSERT INTO ceph_reference_sets(key,name,population,version,active,created_by)
     VALUES('builtin_default','SYN Builtin Reference','SYN Norms','v1',TRUE,'SYN')
     ON CONFLICT (key) DO UPDATE SET active = TRUE RETURNING id`,
  )).rows[0].id);
  await fx.pool.query(
    `INSERT INTO ceph_reference_values(set_id,code,mean,sd)
     VALUES($1,'ANB',2.0,2.0),($1,'FMA',25.0,4.0)
     ON CONFLICT (set_id,code) DO NOTHING`,
    [refSetId],
  );

  // Seed one completed foreign study via the protected owner so cross-patient existence non-disclosure can be tested.
  const ownerSession = await fx.session("owner");
  const createdForeign = await ceph.commandCanonicalCephCreate(ownerSession, ids.foreignPatient, {
    documentId: ids.foreignDoc,
    phase: "pretreatment",
    xrayDate: "2025-05-01",
  });
  await ceph.commandCanonicalCephPatch(ownerSession, createdForeign.id, {
    calibration: { x1: 100, y1: 100, x2: 200, y2: 100, mm: 10 },
    landmarks: syntheticLandmarks(),
  });
  await ceph.commandCanonicalCephComplete(ownerSession, createdForeign.id);
  ids.foreignCompletedId = createdForeign.id;
}, 180_000);

afterAll(async () => {
  await side?.end();
  await fx?.close();
});

it("registers read:ceph on patient scope with clinical.xrays.view", () => {
  expect(CANONICAL_RECORD_READS["read:ceph"]).toEqual({
    record: "patient",
    need: ["clinical.xrays.view"],
    anyOf: [],
  });
});

it("reads active reference sets in a REPEATABLE READ READ ONLY snapshot only for clinical.xrays.view", async () => {
  const viewSession = await fx.session("noneScope"); // holds clinical.xrays.view; reference sets do not require patient scope
  const original = db.listCephReferenceSetsWith;
  const spy = vi.spyOn(db, "listCephReferenceSetsWith").mockImplementationOnce(async q => {
    expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
    expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
    return original(q);
  });
  try {
    const res = await ceph.readCanonicalCephReferenceSets(viewSession);
    expect(Array.isArray(res.sets)).toBe(true);
    expect(res.sets.some(s => s.key === "builtin_default")).toBe(true);
  } finally {
    spy.mockRestore();
  }

  await expect(ceph.readCanonicalCephReferenceSets(await fx.session("adjacent"))).rejects.toThrow(/CAPABILITY_DENIED/);
});

it("enforces exact capability and scope separation across reads and writes", async () => {
  await expect(ceph.readCanonicalPatientCephAnalyses(await fx.session("adjacent"), ids.ownPatient)).rejects.toThrow(
    /CAPABILITY_DENIED/,
  );
  await expect(ceph.readCanonicalPatientCephAnalyses(await fx.session("noneScope"), ids.ownPatient)).rejects.toThrow(
    /RECORD_SCOPE_DENIED/,
  );
  await expect(ceph.readCanonicalPatientCephAnalyses(await fx.session("unlinked"), ids.ownPatient)).rejects.toThrow(
    /RECORD_SCOPE_DENIED|PERMISSIONS_STALE/,
  );
  // Scope none & unlinked refused on writes even when holding all Ceph capabilities
  await expect(
    ceph.commandCanonicalCephCreate(await fx.session("noneScope"), ids.ownPatient, { documentId: ids.ownDoc1 }),
  ).rejects.toThrow(/RECORD_SCOPE_DENIED/);
  await expect(
    ceph.commandCanonicalCephCreate(await fx.session("unlinked"), ids.ownPatient, { documentId: ids.ownDoc1 }),
  ).rejects.toThrow(/RECORD_SCOPE_DENIED|PERMISSIONS_STALE/);
  // View-only actor cannot open or edit studies
  await expect(
    ceph.commandCanonicalCephCreate(await fx.session("allView"), ids.ownPatient, { documentId: ids.ownDoc1 }),
  ).rejects.toThrow(/CAPABILITY_DENIED/);

  // Analyze-only actor cannot create; upload-only actor cannot patch/complete/discard/duplicate
  await expect(
    ceph.commandCanonicalCephCreate(await fx.session("ownAnalyzeOnly"), ids.ownPatient, { documentId: ids.ownDoc1 }),
  ).rejects.toThrow(/CAPABILITY_DENIED/);
  await expect(
    ceph.commandCanonicalCephPatch(await fx.session("ownUploadOnly"), ids.foreignCompletedId, {}),
  ).rejects.toThrow(/CAPABILITY_DENIED/);
});

it("runs the full Ceph lifecycle (create -> atomic patch -> complete -> duplicate -> discard -> T1/T2 compare & superimpose) with atomic audit", async () => {
  const docSession = await fx.session("ownFull");

  // Non-image document refused with 409 without poisoning transaction
  await expect(
    ceph.commandCanonicalCephCreate(docSession, ids.ownPatient, { documentId: ids.ownPdfDoc }),
  ).rejects.toMatchObject({ code: "ceph_conflict", status: 409 });

  // Foreign patient refused with 404 identical to missing patient
  const foreignCreateErr = await ceph
    .commandCanonicalCephCreate(docSession, ids.foreignPatient, { documentId: ids.foreignDoc })
    .then(() => { throw new Error("expected refusal"); }, e => ({ code: e.code, status: e.status, message: e.message }));
  const missingCreateErr = await ceph
    .commandCanonicalCephCreate(docSession, 2147483647, { documentId: ids.ownDoc1 })
    .then(() => { throw new Error("expected refusal"); }, e => ({ code: e.code, status: e.status, message: e.message }));
  expect(foreignCreateErr).toEqual(missingCreateErr);
  expect(foreignCreateErr.status).toBe(404);

  // 1. Open T1 draft
  const t1 = await ceph.commandCanonicalCephCreate(docSession, ids.ownPatient, {
    documentId: ids.ownDoc1,
    phase: "pretreatment",
    xrayDate: "2026-01-10",
    device: "SYN Planmeca",
  });
  expect(t1.id).toBeGreaterThan(0);
  expect(t1.duplicateWarning).toBeNull();

  // Opening a second draft while T1 is open hits the unique-draft savepoint and returns 409 cleanly
  await expect(
    ceph.commandCanonicalCephCreate(docSession, ids.ownPatient, { documentId: ids.ownDoc2, phase: "during" }),
  ).rejects.toMatchObject({ code: "ceph_conflict", status: 409 });

  // Atomic PATCH: invalid diagnosis rolls back calibration in the same request
  await expect(
    ceph.commandCanonicalCephPatch(docSession, t1.id, {
      calibration: { x1: 100, y1: 100, x2: 200, y2: 100, mm: 10 },
      diagnosis: { finalDx: "   " },
    }),
  ).rejects.toMatchObject({ code: "invalid_ceph_input", status: 400 });
  const afterRollback = await ceph.readCanonicalCephStudy(docSession, t1.id);
  expect(afterRollback.analysis.mmPerPixel).toBeNull();

  // Complete before calibration & landmarks is refused with 409
  await expect(ceph.commandCanonicalCephComplete(docSession, t1.id)).rejects.toMatchObject({
    code: "ceph_conflict",
    status: 409,
  });

  // 2. Patch calibration, landmarks, and structured diagnosis atomically
  await ceph.commandCanonicalCephPatch(docSession, t1.id, {
    calibration: { x1: 100, y1: 100, x2: 200, y2: 100, mm: 10 },
    landmarks: syntheticLandmarks(0),
    diagnosis: { skeletal: "صنف ثانٍ هيكلي خفيف", finalDx: "صنف ثانٍ قابل للتعويض" },
  });

  // 3. Complete T1
  const completedT1 = await ceph.commandCanonicalCephComplete(docSession, t1.id);
  expect(completedT1.ok).toBe(true);
  expect(completedT1.measurements.some(m => m.code === "ANB")).toBe(true);

  // Completed study is immutable on PATCH and DELETE
  await expect(
    ceph.commandCanonicalCephPatch(docSession, t1.id, { diagnosis: { finalDx: "محاولة تعديل معتمد" } }),
  ).rejects.toMatchObject({ code: "ceph_conflict", status: 409 });
  await expect(ceph.commandCanonicalCephDiscard(docSession, t1.id, "رفض معتمد")).rejects.toMatchObject({
    code: "ceph_conflict",
    status: 409,
  });

  // 4. Duplicate T1 into a correction draft, verify duplicateWarning & discard it
  const dup = await ceph.commandCanonicalCephDuplicate(docSession, t1.id);
  expect(dup.id).toBeGreaterThan(t1.id);
  const dupStudy = await ceph.readCanonicalCephStudy(docSession, dup.id);
  expect(dupStudy.analysis.status).toBe("draft");
  expect(dupStudy.analysis.xrayDate).toBe("2026-01-10");
  expect(dupStudy.landmarks.length).toBe(REQUIRED_LANDMARKS.length);

  await ceph.commandCanonicalCephDiscard(docSession, dup.id, "نسخة تجريبية ملغاة");
  await expect(ceph.readCanonicalCephStudy(docSession, dup.id)).rejects.toMatchObject({
    code: "ceph_not_found",
    status: 404,
  });

  // 5. Open T2 on the same document (triggers duplicateWarning) and complete with shifted A-point
  const t2 = await ceph.commandCanonicalCephCreate(docSession, ids.ownPatient, {
    documentId: ids.ownDoc1,
    phase: "posttreatment",
    xrayDate: "2026-09-15",
  });
  expect(t2.duplicateWarning).toContain(`#${t1.id}`);
  await ceph.commandCanonicalCephPatch(docSession, t2.id, {
    calibration: { x1: 100, y1: 100, x2: 200, y2: 100, mm: 10 },
    landmarks: syntheticLandmarks(-6),
  });
  await ceph.commandCanonicalCephComplete(docSession, t2.id);

  // 6. Compare & Superimpose (passed in reverse order -> chronologically ordered before=T1, after=T2)
  const cmp = await ceph.readCanonicalCephCompare(
    docSession,
    new URLSearchParams(`first=${t2.id}&second=${t1.id}`),
  );
  expect(cmp.before.id).toBe(t1.id);
  expect(cmp.after.id).toBe(t2.id);
  expect(cmp.comparison.measurements.length).toBeGreaterThan(0);

  const sup = await ceph.readCanonicalCephSuperimpose(
    docSession,
    new URLSearchParams(`first=${t2.id}&second=${t1.id}`),
  );
  expect(sup.before.id).toBe(t1.id);
  expect(sup.after.id).toBe(t2.id);
  expect(typeof sup.rotationDegrees).toBe("number");

  // 7. Verify atomic audit trail recorded all canonical Ceph mutations with username + role
  const audits = (await fx.pool.query<{ action: string; actor: string; actor_role: string }>(
    `SELECT action, actor, actor_role FROM audit_log
     WHERE entity = 'ceph_analysis' AND actor = $1 ORDER BY id`,
    [ACCOUNTS.ownFull.username],
  )).rows;
  expect(audits.map(a => a.action)).toEqual(
    expect.arrayContaining(["ceph.create", "ceph.update", "ceph.complete", "ceph.discard"]),
  );
  expect(audits.every(a => a.actor_role === "doctor")).toBe(true);
});

it("never leaks foreign analysis existence on study read, compare, superimpose, or mutations", async () => {
  const docSession = await fx.session("ownFull");
  const list = await ceph.readCanonicalPatientCephAnalyses(docSession, ids.ownPatient);
  const ownStudyId = list.analyses[0].id;

  // Single study read: foreign vs non-existent ID produce identical 404
  const foreignStudyErr = await ceph
    .readCanonicalCephStudy(docSession, ids.foreignCompletedId)
    .catch(e => ({ code: e.code, status: e.status, message: e.message }));
  const missingStudyErr = await ceph
    .readCanonicalCephStudy(docSession, 2147483647)
    .catch(e => ({ code: e.code, status: e.status, message: e.message }));
  expect(foreignStudyErr).toEqual(missingStudyErr);
  expect(foreignStudyErr).toEqual({ code: "ceph_not_found", status: 404, message: "التحليل غير موجود." });

  // Compare: (ownStudyId, foreignCompletedId) MUST return 404 (not 400 cross-patient!) for own-scoped doctor
  const cmpForeignErr = await ceph
    .readCanonicalCephCompare(docSession, new URLSearchParams(`first=${ownStudyId}&second=${ids.foreignCompletedId}`))
    .catch(e => ({ code: e.code, status: e.status, message: e.message }));
  const cmpMissingErr = await ceph
    .readCanonicalCephCompare(docSession, new URLSearchParams(`first=${ownStudyId}&second=2147483647`))
    .catch(e => ({ code: e.code, status: e.status, message: e.message }));
  expect(cmpForeignErr).toEqual(cmpMissingErr);
  expect(cmpForeignErr).toEqual({ code: "ceph_not_found", status: 404, message: "أحد التحليلين غير موجود." });

  // Superimpose: same non-disclosure invariant
  const supForeignErr = await ceph
    .readCanonicalCephSuperimpose(docSession, new URLSearchParams(`first=${ownStudyId}&second=${ids.foreignCompletedId}`))
    .then(() => { throw new Error("expected refusal"); }, e => ({ code: e.code, status: e.status, message: e.message }));
  const supMissingErr = await ceph
    .readCanonicalCephSuperimpose(docSession, new URLSearchParams(`first=${ownStudyId}&second=2147483647`))
    .then(() => { throw new Error("expected refusal"); }, e => ({ code: e.code, status: e.status, message: e.message }));
  expect(supForeignErr).toEqual(supMissingErr);
  expect(supForeignErr.status).toBe(404);

  // All-scoped viewer CAN see both patients, so cross-patient compare legitimately returns 400
  const allSession = await fx.session("allView");
  await expect(
    ceph.readCanonicalCephCompare(allSession, new URLSearchParams(`first=${ownStudyId}&second=${ids.foreignCompletedId}`)),
  ).rejects.toMatchObject({ code: "invalid_ceph_input", status: 400, message: "التحليلان لمريضين مختلفين." });

  // Duplicate on foreign completed study returns 404 for own-scoped doctor
  await expect(ceph.commandCanonicalCephDuplicate(docSession, ids.foreignCompletedId)).rejects.toMatchObject({
    code: "ceph_not_found",
    status: 404,
  });
});

it("immediately invalidates stale handles and refuses revoked capabilities", async () => {
  const stale = await fx.session("ownFull");
  await fx.setGrants("ownFull", VIEW_ONLY, { patientScope: "own" });
  try {
    await expect(
      ceph.commandCanonicalCephCreate(stale, ids.ownPatient, { documentId: ids.ownDoc2 }),
    ).rejects.toThrow(/STALE/);
    await expect(
      ceph.commandCanonicalCephCreate(await fx.session("ownFull"), ids.ownPatient, { documentId: ids.ownDoc2 }),
    ).rejects.toThrow(/CAPABILITY_DENIED/);
  } finally {
    await fx.setGrants("ownFull", FULL_CEPH, { patientScope: "own" });
  }
});
