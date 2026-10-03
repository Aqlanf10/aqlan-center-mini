import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, rawPool, stubPostgresEnv } from "./_setup";

// Inspect the real environment before any helper can remove production markers.
validatePostgresTestTarget();
assertRealPostgresUrl();
stubPostgresEnv();

const storage = vi.hoisted(() => ({ writes: 0, onWrite: null as (() => Promise<void>) | null }));
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ username: "document-test", role: "admin" }) }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: async () => true }));
vi.mock("@/lib/files", () => ({
  storageStatus: async () => ({ ready: true }),
  putFile: async () => { storage.writes++; await storage.onWrite?.(); return { key: "synthetic.png", sha256: "a".repeat(64), sizeBytes: 67 }; },
}));

const db = await import("../../lib/db");
const { POST } = await import("../../app/api/patients/[id]/documents/route");
const pool = rawPool();
let patient: number, foreignPatient: number, visit: number, anotherVisit: number, foreignVisit: number, unlinkedVisit: number;
let caseId: number, oldCase: number, foreignCase: number, adjustment: number, oldAdjustment: number, foreignAdjustment: number;
let historicalAdjustment: number, corruptAdjustment: number;

const documentInput = (links: { visitId?: number | null; orthoCaseId?: number | null; adjustmentId?: number | null } = {}) => ({
  patientId: patient, visitId: null, kind: "photo" as const, title: "Synthetic association proof", mimeType: "image/png",
  sizeBytes: 67, sha256: "a".repeat(64), storageKey: "synthetic.png", note: null, takenOn: null,
  uploadedBy: "document-test", ...links,
});
const count = async () => Number((await pool.query("SELECT count(*) FROM patient_documents")).rows[0].count);
const upload = async (links: Record<string, string | undefined>) => {
  const form = new FormData();
  form.set("file", new File([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")], "synthetic.png", { type: "image/png" }));
  form.set("kind", "photo");
  for (const [key, value] of Object.entries(links)) {
    if (value !== undefined) form.set(key, value);
  }
  return POST(new Request(`http://test.invalid/api/patients/${patient}/documents`, { method: "POST", body: form }), { params: Promise.resolve({ id: String(patient) }) });
};

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  const p = await pool.query("INSERT INTO patients (patient_number, full_name) VALUES ('DOC-A','Synthetic A'),('DOC-B','Synthetic B') RETURNING id");
  [patient, foreignPatient] = p.rows.map(r => r.id);
  const v = await pool.query("INSERT INTO visits (patient_id,patient_name,status) VALUES ($1,'Synthetic A','waiting'),($1,'Synthetic A2','waiting'),($2,'Synthetic B','waiting'),(NULL,'Unlinked','waiting') RETURNING id", [patient, foreignPatient]);
  [visit, anotherVisit, foreignVisit, unlinkedVisit] = v.rows.map(r => r.id);
  const c = await pool.query("INSERT INTO ortho_cases (patient_id,appliance,arches,slot,start_date,planned_months,created_by,status) VALUES ($1,'fixed_metal','both','022',CURRENT_DATE,12,'test','active'),($1,'fixed_metal','both','022',CURRENT_DATE,12,'test','completed'),($2,'fixed_metal','both','022',CURRENT_DATE,12,'test','active') RETURNING id", [patient, foreignPatient]);
  [caseId, oldCase, foreignCase] = c.rows.map(r => r.id);
  const a = await pool.query("INSERT INTO ortho_adjustments (case_id,visit_id,done_on,elastics,next_weeks,recorded_by) VALUES ($1,$4,CURRENT_DATE,'none',4,'test'),($2,$4,CURRENT_DATE,'none',4,'test'),($3,$5,CURRENT_DATE,'none',4,'test'),($1,NULL,CURRENT_DATE,'none',4,'test'),($1,$5,CURRENT_DATE,'none',4,'test') RETURNING id", [caseId, oldCase, foreignCase, visit, foreignVisit]);
  [adjustment, oldAdjustment, foreignAdjustment, historicalAdjustment, corruptAdjustment] = a.rows.map(r => r.id);
});
afterAll(async () => { await pool.end(); await db.resetPoolForTesting(); });

describe("document association integrity", () => {
  it("preserves supported optional associations without inventing links", async () => {
    for (const links of [{}, { visitId: visit }, { orthoCaseId: caseId }, { adjustmentId: adjustment },
      { orthoCaseId: caseId, visitId: anotherVisit }, { adjustmentId: historicalAdjustment },
      { orthoCaseId: oldCase, adjustmentId: oldAdjustment, visitId: visit },
      { orthoCaseId: caseId, adjustmentId: adjustment, visitId: visit }]) {
      const result = await db.recordDocument(documentInput(links));
      expect(result).toMatchObject({ patientId: patient, visitId: links.visitId ?? null, orthoCaseId: links.orthoCaseId ?? null, adjustmentId: links.adjustmentId ?? null });
    }
  });

  it("keeps valid uploads and signed-visit documentation working", async () => {
    const writes = storage.writes;
    for (const links of [{}, { visitId: "", orthoCaseId: "", adjustmentId: "" },
      { visitId: String(visit), orthoCaseId: String(caseId), adjustmentId: String(adjustment) }]) {
      const response = await upload(links);
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ patientId: patient });
    }
    expect(storage.writes).toBe(writes + 3);
    await pool.query("UPDATE visits SET signed_at=NOW() WHERE id=$1", [anotherVisit]);
    try {
      expect((await db.recordDocument(documentInput({ visitId: anotherVisit }))).visitId).toBe(anotherVisit);
    } finally { await pool.query("UPDATE visits SET signed_at=NULL WHERE id=$1", [anotherVisit]); }
  });

  it("fails closed for an absent patient and malformed direct-caller IDs", async () => {
    const before = await count();
    await expect(db.recordDocument({ ...documentInput(), patientId: 2147483647 })).rejects.toMatchObject({ name: "DocumentAssociationError" });
    for (const field of ["visitId", "orthoCaseId", "adjustmentId"]) {
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2147483648]) {
        await expect(db.recordDocument({ ...documentInput(), [field]: value })).rejects.toMatchObject({ name: "DocumentAssociationError" });
      }
    }
    expect(await count()).toBe(before);
  });

  it("rejects missing, foreign, unlinked and mutually inconsistent associations atomically", async () => {
    const before = await count();
    for (const links of [{ visitId: foreignVisit }, { visitId: unlinkedVisit }, { visitId: 2147483647 },
      { orthoCaseId: foreignCase }, { orthoCaseId: 2147483647 }, { adjustmentId: foreignAdjustment },
      { adjustmentId: 2147483647 }, { adjustmentId: corruptAdjustment },
      { orthoCaseId: caseId, adjustmentId: oldAdjustment },
      { adjustmentId: adjustment, visitId: anotherVisit }, { adjustmentId: historicalAdjustment, visitId: visit }]) {
      await expect(db.recordDocument(documentInput(links))).rejects.toMatchObject({ name: "DocumentAssociationError" });
    }
    expect(await count()).toBe(before);
  });

  it("preflights invalid uploads before storage, with the same nonrevealing 400 response", async () => {
    const before = await count(), writes = storage.writes;
    const responses: unknown[] = [];
    for (const links of [{ visitId: String(foreignVisit) }, { visitId: String(unlinkedVisit) }, { visitId: "2147483647" },
      { orthoCaseId: String(foreignCase) }, { adjustmentId: String(foreignAdjustment) },
      { orthoCaseId: String(caseId), adjustmentId: String(oldAdjustment) },
      { adjustmentId: String(adjustment), visitId: String(anotherVisit) }]) {
      const response = await upload(links);
      expect(response.status).toBe(400);
      responses.push(await response.json());
    }
    expect(responses.every(value => JSON.stringify(value) === JSON.stringify(responses[0]))).toBe(true);
    expect(storage.writes).toBe(writes);
    expect(await count()).toBe(before);
  });

  it("does not silently strip malformed explicit association IDs", async () => {
    const writes = storage.writes;
    for (const field of ["visitId", "orthoCaseId", "adjustmentId"]) {
      for (const value of ["0", "-1", "abc", "1.5", "1e2", "2147483648", " "]) {
        expect((await upload({ [field]: value })).status).toBe(400);
      }
    }
    expect(storage.writes).toBe(writes);
  });

  it("revalidates after storage when an association changes after preflight", async () => {
    const before = await count(), writes = storage.writes;
    storage.onWrite = async () => { await pool.query("UPDATE visits SET patient_id=$2 WHERE id=$1", [anotherVisit, foreignPatient]); };
    try {
      const response = await upload({ visitId: String(anotherVisit) });
      expect(response.status).toBe(400);
      expect(storage.writes).toBe(writes + 1); // orphan bytes are safe; no blind shared-key delete
      expect(await count()).toBe(before);
    } finally {
      storage.onWrite = null;
      await pool.query("UPDATE visits SET patient_id=$2 WHERE id=$1", [anotherVisit, patient]);
    }
  });

  it("filters legacy inconsistent album metadata without modifying stored documents", async () => {
    const valid = await db.recordDocument(documentInput({ orthoCaseId: caseId, adjustmentId: adjustment, visitId: visit }));
    const adjustmentOnly = await db.recordDocument(documentInput({ adjustmentId: adjustment }));
    const caseOnly = await db.recordDocument(documentInput({ orthoCaseId: caseId }));
    const corrupt: number[] = [];
    for (const [p,c,a,v] of [[foreignPatient,caseId,adjustment,visit], [patient,foreignCase,adjustment,visit],
      [patient,caseId,oldAdjustment,visit], [patient,caseId,adjustment,foreignVisit],
      [patient,caseId,adjustment,anotherVisit], [patient,caseId,historicalAdjustment,visit],
      [patient,caseId,corruptAdjustment,null], [patient,caseId,null,unlinkedVisit]]) {
      const { rows } = await pool.query("INSERT INTO patient_documents (patient_id,ortho_case_id,adjustment_id,visit_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES ($1,$2,$3,$4,'photo','Synthetic legacy mismatch','image/png',67,$5,'synthetic.png','test') RETURNING id", [p,c,a,v,"a".repeat(64)]);
      corrupt.push(rows[0].id);
    }
    const before = await count();
    const legacyBefore = (await pool.query("SELECT * FROM patient_documents WHERE id=ANY($1::int[]) ORDER BY id", [corrupt])).rows;
    const album = await db.listOrthoCasePhotos(caseId);
    expect(album.map(d => d.id)).toContain(valid.id);
    expect(album.map(d => d.id)).toContain(caseOnly.id);
    expect(album.map(d => d.id)).not.toContain(adjustmentOnly.id); // no historical case link inferred
    expect(album.filter(d => corrupt.includes(d.id))).toEqual([]);
    const ortho = await db.getOrthoCase(caseId, "2026-10-03");
    const photos = ortho!.adjustments.find(a => a.id === adjustment)!.photos;
    expect(photos.map(d => d.id)).toEqual(expect.arrayContaining([valid.id, adjustmentOnly.id]));
    expect(ortho!.adjustments.flatMap(a => a.photos).filter(d => corrupt.includes(d.id))).toEqual([]);
    expect(await count()).toBe(before);
    expect((await pool.query("SELECT * FROM patient_documents WHERE id=ANY($1::int[]) ORDER BY id", [corrupt])).rows).toEqual(legacyBefore);
  });

  it("rechecks a visit after a concurrent relink wins its row lock", async () => {
    const blocker = await pool.connect();
    const before = await count();
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE visits SET patient_id=$2 WHERE id=$1", [anotherVisit, foreignPatient]);
      const pending = db.recordDocument(documentInput({ visitId: anotherVisit })).then(
        value => ({ value, error: null }), error => ({ value: null, error }));
      await waitForLock("FROM visits WHERE id = $1");
      await blocker.query("COMMIT");
      expect((await pending).error).toMatchObject({ name: "DocumentAssociationError" });
      expect(await count()).toBe(before);
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.query("UPDATE visits SET patient_id=$2 WHERE id=$1", [anotherVisit, patient]);
      blocker.release();
    }
  });

  it.each(["case_id", "visit_id"] as const)("rejects a stale adjustment %s snapshot after waiting for its original visit", async (field) => {
    const blocker = await pool.connect();
    const before = await count();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM visits WHERE id=$1 FOR UPDATE", [visit]);
      const pending = db.recordDocument(documentInput({ adjustmentId: oldAdjustment })).then(
        value => ({ value, error: null }), error => ({ value: null, error }));
      await waitForLock("FROM visits WHERE id = $1");
      // The unlocked initial identity is now stale, before the writer locks its case.
      await pool.query(`UPDATE ortho_adjustments SET ${field}=$2 WHERE id=$1`, [oldAdjustment, field === "case_id" ? foreignCase : foreignVisit]);
      await blocker.query("COMMIT");
      expect((await pending).error).toMatchObject({ name: "DocumentAssociationError" });
      expect(await count()).toBe(before);
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.query("UPDATE ortho_adjustments SET case_id=$2,visit_id=$3 WHERE id=$1", [oldAdjustment, oldCase, visit]);
      blocker.release();
    }
  });

  it("rechecks case ownership after a concurrent case move wins its lock", async () => {
    const blocker = await pool.connect();
    const before = await count();
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE ortho_cases SET patient_id=$2 WHERE id=$1", [oldCase, foreignPatient]);
      const pending = db.recordDocument(documentInput({ orthoCaseId: oldCase })).then(
        value => ({ value, error: null }), error => ({ value: null, error }));
      await waitForLock("FROM ortho_cases WHERE id = $1");
      await blocker.query("COMMIT");
      expect((await pending).error).toMatchObject({ name: "DocumentAssociationError" });
      expect(await count()).toBe(before);
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.query("UPDATE ortho_cases SET patient_id=$2 WHERE id=$1", [oldCase, patient]);
      blocker.release();
    }
  });

  it("an actual patient merge waits at the parent while an upload commits, then moves coherent metadata", async () => {
    const fixture = await createMergeFixture("UPLOAD-FIRST");
    const gate = await pool.connect();
    let pending: ReturnType<typeof db.recordDocument> | undefined;
    let merge: ReturnType<typeof db.mergeDuplicatePatient> | undefined;
    await pool.query(`CREATE FUNCTION document_merge_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(913024); RETURN NEW; END $$;
      CREATE TRIGGER document_merge_gate BEFORE INSERT ON patient_documents FOR EACH ROW EXECUTE FUNCTION document_merge_gate()`);
    try {
      await gate.query("SELECT pg_advisory_lock(913024)");
      pending = db.recordDocument({ ...documentInput(), patientId: fixture.source, visitId: fixture.visit, orthoCaseId: fixture.caseId });
      void pending.catch(() => {});
      await waitForLock("INSERT INTO patient_documents");
      merge = db.mergeDuplicatePatient(fixture.source, fixture.target, { actor: "document-test" });
      void merge.catch(() => {});
      await waitForLock("FROM patients WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE");
      await gate.query("SELECT pg_advisory_unlock(913024)");
      const document = await pending;
      expect(await merge).toMatchObject({ ok: true });
      expect((await db.getDocumentForDownload(document.id))?.document.patientId).toBe(fixture.target);
      expect((await db.listOrthoCasePhotos(fixture.caseId)).map(d => d.id)).toContain(document.id);
    } finally {
      await gate.query("SELECT pg_advisory_unlock(913024)");
      await Promise.allSettled([pending, merge]);
      gate.release();
      await pool.query("DROP TRIGGER document_merge_gate ON patient_documents; DROP FUNCTION document_merge_gate()");
    }
  });

  it("a merge-first upload waits at its patient check then rejects the removed source", async () => {
    const fixture = await createMergeFixture("MERGE-FIRST");
    const gate = await pool.connect();
    let pending: ReturnType<typeof db.recordDocument> | undefined;
    let merge: ReturnType<typeof db.mergeDuplicatePatient> | undefined;
    await pool.query(`CREATE FUNCTION document_parent_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(913025); RETURN NEW; END $$;
      CREATE TRIGGER document_parent_gate BEFORE UPDATE OF patient_id ON ortho_cases FOR EACH ROW EXECUTE FUNCTION document_parent_gate()`);
    try {
      await gate.query("SELECT pg_advisory_lock(913025)");
      merge = db.mergeDuplicatePatient(fixture.source, fixture.target, { actor: "document-test" });
      void merge.catch(() => {});
      await waitForLock("UPDATE ortho_cases SET patient_id = $1 WHERE patient_id = $2");
      pending = db.recordDocument({ ...documentInput(), patientId: fixture.source, visitId: fixture.visit, orthoCaseId: fixture.caseId });
      void pending.catch(() => {});
      await waitForLock("FROM patients WHERE id = $1 FOR KEY SHARE");
      await gate.query("SELECT pg_advisory_unlock(913025)");
      expect(await merge).toMatchObject({ ok: true });
      await expect(pending).rejects.toMatchObject({ name: "DocumentAssociationError" });
      expect((await pool.query("SELECT id FROM patient_documents WHERE patient_id=ANY($1::int[])", [[fixture.source, fixture.target]])).rows).toEqual([]);
    } finally {
      await gate.query("SELECT pg_advisory_unlock(913025)");
      await Promise.allSettled([pending, merge]);
      gate.release();
      await pool.query("DROP TRIGGER document_parent_gate ON ortho_cases; DROP FUNCTION document_parent_gate()");
    }
  });

  it("a deletion-first upload waits at its patient check and cannot recreate metadata for a deleted patient", async () => {
    const { rows: [source] } = await pool.query("INSERT INTO patients (patient_number,full_name) VALUES ('DOC-DELETE-FIRST','Synthetic delete') RETURNING id");
    const { rows: [v] } = await pool.query("INSERT INTO visits (patient_id,patient_name,status) VALUES ($1,'Synthetic delete','waiting') RETURNING id", [source.id]);
    const gate = await pool.connect();
    let pending: ReturnType<typeof db.recordDocument> | undefined;
    let deletion: ReturnType<typeof db.deletePatientCascade> | undefined;
    await pool.query(`CREATE FUNCTION document_delete_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(913026); RETURN OLD; END $$;
      CREATE TRIGGER document_delete_gate BEFORE DELETE ON visits FOR EACH ROW EXECUTE FUNCTION document_delete_gate()`);
    try {
      await gate.query("SELECT pg_advisory_lock(913026)");
      deletion = db.deletePatientCascade(source.id, { actor: "document-test", reason: "Synthetic test only" });
      void deletion.catch(() => {});
      await waitForLock("DELETE FROM visits WHERE patient_id = $1");
      pending = db.recordDocument({ ...documentInput(), patientId: source.id, visitId: v.id });
      void pending.catch(() => {});
      await waitForLock("FROM patients WHERE id = $1 FOR KEY SHARE");
      await gate.query("SELECT pg_advisory_unlock(913026)");
      expect(await deletion).toMatchObject({ ok: true });
      await expect(pending).rejects.toMatchObject({ name: "DocumentAssociationError" });
      expect((await pool.query("SELECT id FROM patient_documents WHERE patient_id=$1", [source.id])).rows).toEqual([]);
    } finally {
      await gate.query("SELECT pg_advisory_unlock(913026)");
      await Promise.allSettled([pending, deletion]);
      gate.release();
      await pool.query("DROP TRIGGER document_delete_gate ON visits; DROP FUNCTION document_delete_gate()");
    }
  });

  it("holds every association row against non-key mutations until document insertion commits", async () => {
    const gate = await pool.connect();
    const mutations: Promise<unknown>[] = [];
    let pending: ReturnType<typeof db.recordDocument> | undefined;
    await pool.query(`CREATE FUNCTION document_test_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(913023); RETURN NEW; END $$;
      CREATE TRIGGER document_test_gate BEFORE INSERT ON patient_documents FOR EACH ROW EXECUTE FUNCTION document_test_gate()`);
    try {
      await gate.query("SELECT pg_advisory_lock(913023)");
      pending = db.recordDocument(documentInput({ orthoCaseId: caseId, adjustmentId: adjustment, visitId: visit }));
      void pending.catch(() => {});
      await waitForLock("INSERT INTO patient_documents");
      for (const [table, column, id] of [["visits", "patient_id", visit], ["ortho_cases", "patient_id", caseId], ["ortho_adjustments", "visit_id", adjustment]] as const) {
        const sql = `UPDATE ${table} SET ${column}=${column} WHERE id=$1`;
        mutations.push(pool.query(sql, [id]));
        await waitForLock(sql);
      }
    } finally {
      await gate.query("SELECT pg_advisory_unlock(913023)");
      gate.release();
      if (pending) expect((await pending).patientId).toBe(patient);
      await Promise.all(mutations);
      await pool.query("DROP TRIGGER document_test_gate ON patient_documents; DROP FUNCTION document_test_gate()");
    }
  });

});

async function waitForLock(query: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND position($1 in query)>0", [query]);
    if (result.rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Expected real PostgreSQL lock wait for ${query}`);
}

async function createMergeFixture(label: string) {
  const { rows } = await pool.query("INSERT INTO patients (patient_number,full_name) VALUES ($1,'Synthetic merge source'),($2,'Synthetic merge target') RETURNING id", [`DOC-${label}-S`, `DOC-${label}-T`]);
  const [source, target] = rows.map(r => r.id as number);
  const { rows: [visit] } = await pool.query("INSERT INTO visits (patient_id,patient_name,status) VALUES ($1,'Synthetic merge','waiting') RETURNING id", [source]);
  const { rows: [ortho] } = await pool.query("INSERT INTO ortho_cases (patient_id,appliance,arches,slot,start_date,planned_months,created_by) VALUES ($1,'fixed_metal','both','022',CURRENT_DATE,12,'test') RETURNING id", [source]);
  return { source, target, visit: visit.id as number, caseId: ortho.id as number };
}
