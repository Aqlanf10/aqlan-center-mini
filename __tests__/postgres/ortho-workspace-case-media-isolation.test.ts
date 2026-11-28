import { afterAll, beforeAll, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { validatePostgresTestTarget } from "./_safe-target";

validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const store = await import("../../lib/ortho-workspace-store");
let patientId: number;
let a: number;
let b: number;
let unrelated: number;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  const q = db.getPool();
  const { rows } = await q.query<{id:number}>(`
    INSERT INTO patients(patient_number,full_name)
    VALUES ('P-11111','SYN case media'), ('P-11112','SYN unrelated') RETURNING id`);
  patientId = rows[0].id;
  const result = await q.query<{id:number}>(`
    INSERT INTO ortho_cases(patient_id,status,created_by)
    VALUES ($1,'closed','test'), ($1,'active','test'), ($2,'active','test') RETURNING id`,
    [patientId, rows[1].id]);
  [a,b,unrelated] = result.rows.map(row => row.id);
});
afterAll(async () => { await db.resetPoolForTesting(); });

it("isolates same-patient media revisions, retains unassigned intake and refuses an unrelated case", async () => {
  const intake = await store.saveOrthoWorkspaceRecord(patientId, {
    orthoCoreCase: { media: [{ id: "unassigned", crop: { x: 99 } }] },
  },"synthetic",0,{ orthoCaseId: null });
  expect(intake.ok).toBe(true);
  expect((await store.loadOrthoWorkspaceRecord(patientId,a)).orthoCoreCase).toBeUndefined();
  expect((await store.loadOrthoWorkspaceRecord(patientId,b)).orthoCoreCase).toBeUndefined();
  const A = { media: [{ id: "a", crop: { x: 4 }, annotations: ["SYN A"] }] };
  const B = { media: [{ id: "b", crop: { x: 25 }, annotations: ["SYN B"] }] };
  expect((await store.saveOrthoWorkspaceRecord(patientId,{ orthoCoreCase: A },"synthetic",0,{ orthoCaseId: a })).ok).toBe(true);
  expect((await store.saveOrthoWorkspaceRecord(patientId,{ orthoCoreCase: B },"synthetic",0,{ orthoCaseId: b })).ok).toBe(true);
  expect(await store.loadOrthoWorkspaceRecord(patientId,a)).toMatchObject({ orthoCaseId:a, revision:1, orthoCoreCase:A });
  expect(await store.loadOrthoWorkspaceRecord(patientId,b)).toMatchObject({ orthoCaseId:b, revision:1, orthoCoreCase:B });
  expect(await store.loadOrthoWorkspaceRecord(patientId)).toMatchObject({ orthoCaseId:null, revision:1,
    orthoCoreCase:{media:[{id:"unassigned",crop:{x:99}}]} });
  expect(await store.saveOrthoWorkspaceRecord(patientId,{orthoCoreCase:B},"synthetic",0,{orthoCaseId:a})).toMatchObject({ok:false,status:409});
  expect(await store.orthoWorkspaceCaseBelongsToPatient(patientId,unrelated)).toBe(false);
  expect(await store.saveOrthoWorkspaceRecord(patientId,{orthoCoreCase:B},"synthetic",0,{orthoCaseId:unrelated})).toMatchObject({ok:false,status:404});
});
