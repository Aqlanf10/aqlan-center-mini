import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeClinicalProcedureId } from "../../lib/clinical-procedure-id";
import { authedGet, harness } from "./_server";

// Dedicated real HTTP/PG regression; no browser stubbing or relaxed DTO parser.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId: number;
let documentId: number;
let originalId: number;
let correctionId: number;
let rawOriginalId: string;
let before: unknown;

beforeAll(async () => {
  h = await harness();
  if (new URL(h.seeded.dbUrl).pathname !== "/aqlan_sec_http") throw new Error("Isolated security fixture required.");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const doctor = (await db.query<{ party_id: number }>("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0];
  patientId = (await db.query<{ id: number }>(
    "INSERT INTO patients (patient_number,full_name,primary_doctor_id) VALUES ($1,'Synthetic Ceph DTO HTTP fixture',$2) RETURNING id",
    [`SYN-CEPH-DTO-${randomUUID()}`, doctor.party_id])).rows[0].id;
  documentId = (await db.query<{ id: number }>(
    `INSERT INTO patient_documents (patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by)
     VALUES ($1,'imaging','Synthetic image','image/png',1,'synthetic-ceph-dto-http','synthetic/no-file.png','synthetic-ceph-dto-http') RETURNING id`, [patientId])).rows[0].id;
  rawOriginalId = (await db.query<{ id: string }>(
    `INSERT INTO ceph_analyses (patient_id,document_id,status,phase,xray_date,mm_per_pixel,created_by,completed_by,completed_at)
     VALUES ($1,$2,'completed','during','2026-08-20',0.125,'synthetic-ceph-dto-http','synthetic-ceph-dto-http',NOW()) RETURNING id`,
    [patientId, documentId])).rows[0].id;
  expect(typeof rawOriginalId).toBe("string");
  originalId = normalizeClinicalProcedureId(rawOriginalId);
  const rawCorrectionId = (await db.query<{ id: string }>(
    `INSERT INTO ceph_analyses (patient_id,document_id,status,phase,xray_date,created_by,corrects_analysis_id)
     VALUES ($1,$2,'draft','during','2026-08-20','synthetic-ceph-dto-http',$3) RETURNING id`,
    [patientId, documentId, rawOriginalId])).rows[0].id;
  correctionId = normalizeClinicalProcedureId(rawCorrectionId);
  await db.query("INSERT INTO ceph_measurements (analysis_id,code,value) VALUES ($1,'ANB',3.4),($1,'FMA',27.25),($1,'WITS',-2.5)", [rawOriginalId]);
  before = (await db.query("SELECT to_jsonb(a) AS row FROM ceph_analyses a WHERE patient_id=$1 ORDER BY id", [patientId])).rows;
});
afterAll(async () => { await db?.end(); });

describe("Ceph list transport DTO on the actual built server", () => {
  it("returns strict safe-number identities and exact stored findings/lineage", async () => {
    for (const session of [h.sessions.admin, h.sessions.doctorA]) {
      const response = await authedGet(`/api/patients/${patientId}/ceph`, session);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(Buffer.byteLength(text)).toBeLessThan(32_000);
      const body = JSON.parse(text);
      expect(Array.isArray(body.analyses)).toBe(true);
      expect(body.analyses).toHaveLength(2);
      for (const row of body.analyses) {
        // Same numeric/owner requirements as PatientCeph's unchanged boundary.
        expect(row.patientId).toBe(patientId);
        expect(typeof row.id).toBe("number");
        expect(Number.isSafeInteger(row.id) && row.id > 0).toBe(true);
        expect(row.documentId).toBe(documentId);
        expect(row.orthoCaseId).toBeNull();
        expect(row.xrayDate).toBe("2026-08-20");
        expect(Array.isArray(row.correctedBy)).toBe(true);
        for (const id of row.correctedBy) expect(typeof id === "number" && Number.isSafeInteger(id) && id > 0).toBe(true);
      }
      const original = body.analyses.find((row: { id: number }) => row.id === originalId);
      const correction = body.analyses.find((row: { id: number }) => row.id === correctionId);
      expect(original).toMatchObject({ id: originalId, correctsAnalysisId: null, correctedBy: [correctionId], mmPerPixel: 0.125,
        findings: { anb: 3.4, fma: 27.25, wits: -2.5 } });
      expect(correction).toMatchObject({ id: correctionId, correctsAnalysisId: originalId, correctedBy: [], findings: null });
    }
    expect((await db.query("SELECT to_jsonb(a) AS row FROM ceph_analyses a WHERE patient_id=$1 ORDER BY id", [patientId])).rows).toEqual(before);
    expect((await db.query<{ id: string }>("SELECT id FROM ceph_analyses WHERE id=$1", [rawOriginalId])).rows[0].id).toBe(rawOriginalId);
  });

  it("retains the existing other-doctor authorization refusal", async () => {
    expect((await authedGet(`/api/patients/${patientId}/ceph`, h.sessions.doctorB)).status).toBe(403);
  });
});
