import { Client } from "pg";
import { expect } from "vitest";
import { harness } from "./_server";

/**
 * NEW, AUTHORED UNRUN candidate support for the existing security-HTTP harness.
 * Root review/integration and an explicit runtime grant are required before use.
 * This is not a server, schema initializer, database reset, or alternate harness.
 */
export async function openLinkedClinicalFixtures() {
  const h = await harness();
  const target = new URL(h.seeded.dbUrl);
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(target.hostname);
  expect(target.pathname).toBe("/aqlan_sec_http");
  const db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  try {
    const database = await db.query<{ name: string }>("SELECT current_database() AS name");
    expect(database.rows[0].name).toBe("aqlan_sec_http");
    const doctor = await db.query<{ party_id: number }>(
      `SELECT u.party_id FROM users u JOIN parties p ON p.id = u.party_id
         WHERE u.username = 'secdoctora' AND u.role = 'doctor' AND p.kind = 'doctor'`,
    );
    expect(doctor.rows).toHaveLength(1);
    expect(doctor.rows[0].party_id).toBeGreaterThan(0);
    return { h, db, doctorId: doctor.rows[0].party_id };
  } catch (error) {
    await db.end();
    throw error;
  }
}

export interface LinkedClinicalFixture {
  patientId: number;
  caseId: number;
  visitId: number;
  doctorId: number;
}

/** Every test owns a new, already-linked synthetic patient/case/visit. */
export async function createLinkedClinicalFixture(
  db: Client,
  doctorId: number,
  marker: string,
): Promise<LinkedClinicalFixture> {
  const patient = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id)
       VALUES ($1, $2, $3) RETURNING id`,
    [marker, `Synthetic linked clinical ${marker}`, doctorId],
  );
  const patientId = patient.rows[0].id;
  const clinicalCase = await db.query<{ id: number }>(
    `INSERT INTO clinical_cases (patient_id, specialty, title, responsible_party_id, created_by)
       VALUES ($1, 'periodontics', $2, $3, 'synthetic-linked-http-fixture') RETURNING id`,
    [patientId, `Synthetic linked case ${marker}`, doctorId],
  );
  const caseId = clinicalCase.rows[0].id;
  const visit = await db.query<{ id: number }>(
    `INSERT INTO visits (patient_id, patient_name, case_id, doctor_id, status, billing_currency, arrived_at)
       VALUES ($1, $2, $3, $4, 'seated', 'USD', NOW()) RETURNING id`,
    [patientId, `Synthetic linked clinical ${marker}`, caseId, doctorId],
  );
  return { patientId, caseId, visitId: visit.rows[0].id, doctorId };
}

type StoredRow = Record<string, unknown>;
export interface LinkedClinicalSnapshot {
  visit: StoredRow;
  procedures: StoredRow[];
  clinicalAudits: StoredRow[];
  exams: StoredRow[];
  sites: StoredRow[];
  addenda: StoredRow[];
  perioAudits: StoredRow[];
  invoices: StoredRow[];
  payments: StoredRow[];
}

/** One SQL statement: complete rows, stable IDs and timestamps, never totals alone. */
export async function linkedClinicalSnapshot(db: Client, f: LinkedClinicalFixture): Promise<LinkedClinicalSnapshot> {
  const result = await db.query<{ snapshot: LinkedClinicalSnapshot }>(
    `SELECT jsonb_build_object(
       'visit', to_jsonb(v),
       'procedures', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb)
         FROM visit_procedures p WHERE p.visit_id = v.id),
       'clinicalAudits', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb)
         FROM audit_log a WHERE a.entity = 'visit' AND a.entity_id = v.id::text),
       'exams', (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]'::jsonb)
         FROM perio_exams e WHERE e.visit_id = v.id),
       'sites', (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb)
         FROM perio_site_observations s JOIN perio_exams e ON e.id = s.exam_id WHERE e.visit_id = v.id),
       'addenda', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb)
         FROM perio_addenda a JOIN perio_exams e ON e.id = a.exam_id WHERE e.visit_id = v.id),
       'perioAudits', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb)
         FROM audit_log a WHERE a.entity = 'patient' AND a.entity_id = v.patient_id::text
           AND a.action LIKE 'perio.%' AND a.details ->> 'visitId' = v.id::text),
       'invoices', (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
         FROM invoices i WHERE i.patient_id = v.patient_id),
       'payments', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb)
         FROM payments p WHERE p.patient_id = v.patient_id)
     ) AS snapshot FROM visits v WHERE v.id = $1 AND v.patient_id = $2 AND v.case_id = $3`,
    [f.visitId, f.patientId, f.caseId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0].snapshot;
}
