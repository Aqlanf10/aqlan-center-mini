import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
let db:PGlite;let seq=0;
const q=async(sql:string,args:unknown[]=[]) => (await db.query(sql,args)).rows as Record<string,unknown>[];
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`CREATE TABLE users(id integer PRIMARY KEY);
    CREATE TABLE ortho_cases(id integer PRIMARY KEY,patient_id integer);
    CREATE TABLE clinical_cases(id integer PRIMARY KEY);
    CREATE TABLE treatment_plans(id integer PRIMARY KEY);
    CREATE TABLE plan_items(id integer PRIMARY KEY);
    CREATE TABLE invoices(id integer PRIMARY KEY);
    CREATE TABLE visits(id integer PRIMARY KEY,patient_id integer,signed_at timestamptz,signed_by text);
    CREATE TABLE ortho_adjustments(id integer PRIMARY KEY,case_id integer REFERENCES ortho_cases(id),visit_id integer REFERENCES visits(id),billing_class text,done text,done_on date,billing_decision text,billing_invoice_id integer);
    INSERT INTO users VALUES(1);`);
  await db.exec(readFileSync(new URL('../migrations/0079_ortho_followup_coverage.sql',import.meta.url),'utf8'));
},90_000);
afterAll(async()=>{await db.close();});
async function fixture(){
  const id=++seq;
  await db.exec(`INSERT INTO ortho_cases VALUES(${id},${id}); INSERT INTO clinical_cases VALUES(${id});
    INSERT INTO treatment_plans VALUES(${id}); INSERT INTO plan_items VALUES(${id}); INSERT INTO invoices VALUES(${id});`);
  const snapshot={format:1,case:[id,id],clinical:[id,id,id],plan:[id,id],item:[id,id,id],invoice:[id,id]};
  const [r]=await q(`INSERT INTO ortho_followup_coverage_revisions
    (patient_id,ortho_case_id,clinical_case_id,plan_id,plan_item_id,invoice_id,version,scope,decision,source_fingerprint,source_snapshot,reason,actor_user_id,created_by,command_id,request_fingerprint)
    VALUES($1,$1,$1,$1,$1,$1,1,'routine_adjustments','included',$2,$3,'Synthetic proof',1,'synthetic', $4,$2) RETURNING id::text`,
    [id,'a'.repeat(64),JSON.stringify(snapshot),`00000000-0000-4000-8000-${String(id).padStart(12,'0')}`]);
  const tuple={adjustmentId:id,caseId:id,revisionId:String(r.id),patientId:id};
  return {id,revision:String(r.id),tuple};
}
async function signed(){
  const f=await fixture();
  await q('INSERT INTO visits(id,patient_id) VALUES($1,$1)',[f.id]);
  await q(`INSERT INTO ortho_adjustments(id,case_id,visit_id,billing_class,followup_coverage_revision_id) VALUES($1,$1,$1,'INCLUDED',$2)`,[f.id,f.revision]);
  await q(`UPDATE visits SET signed_at='2026-10-20T00:00:00Z',signed_by='synthetic',ortho_followup_coverage_proof=$2 WHERE id=$1`,[f.id,JSON.stringify([f.tuple])]);
  return f;
}
describe('immutable signed orthodontic coverage manifest',()=>{
  it('restores signed parent before its exact child without disabling guards',async()=>{
    const f=await fixture();
    await db.exec('BEGIN');
    try{
      await q(`INSERT INTO visits(id,patient_id,signed_at,signed_by,ortho_followup_coverage_proof) VALUES($1,$1,'2026-10-20T00:00:00Z','synthetic',$2)`,[f.id,JSON.stringify([f.tuple])]);
      await q(`INSERT INTO ortho_adjustments(id,case_id,visit_id,billing_class,followup_coverage_revision_id) VALUES($1,$1,$1,'INCLUDED',$2)`,[f.id,f.revision]);
      await db.exec('COMMIT');
    }catch(e){await db.exec('ROLLBACK');throw e;}
    expect((await q('SELECT ortho_followup_coverage_proof FROM visits WHERE id=$1',[f.id]))[0].ortho_followup_coverage_proof).toEqual([f.tuple]);
  });
  it('rejects signatures without complete proof manifests and restores missing children',async()=>{
    const f=await fixture();
    await q('INSERT INTO visits(id,patient_id) VALUES($1,$1)',[f.id]);
    await q(`INSERT INTO ortho_adjustments(id,case_id,visit_id,billing_class,followup_coverage_revision_id) VALUES($1,$1,$1,'INCLUDED',$2)`,[f.id,f.revision]);
    await expect(q(`UPDATE visits SET signed_at=NOW(),signed_by='synthetic' WHERE id=$1`,[f.id])).rejects.toThrow('children mismatch');
    const g=await fixture();
    await expect(q(`INSERT INTO visits(id,patient_id,signed_at,signed_by,ortho_followup_coverage_proof) VALUES($1,$1,NOW(),'synthetic',$2)`,[g.id,JSON.stringify([g.tuple])])).rejects.toThrow('children mismatch');
  });
  it('rejects proof carrier deletion, reparenting, signature laundering and retrospective proof',async()=>{
    const f=await signed();
    for(const sql of ['DELETE FROM ortho_adjustments WHERE id=$1','UPDATE ortho_adjustments SET visit_id=NULL WHERE id=$1','UPDATE ortho_adjustments SET followup_coverage_revision_id=NULL WHERE id=$1','DELETE FROM visits WHERE id=$1','UPDATE visits SET signed_at=NULL WHERE id=$1','UPDATE visits SET ortho_followup_coverage_proof=NULL WHERE id=$1'])
      await expect(q(sql,[f.id])).rejects.toThrow();
    const g=await fixture();
    await q(`INSERT INTO visits(id,patient_id,signed_at,signed_by) VALUES($1,$1,NOW(),'synthetic')`,[g.id]);
    await expect(q(`UPDATE visits SET ortho_followup_coverage_proof=$2 WHERE id=$1`,[g.id,JSON.stringify([g.tuple])])).rejects.toThrow('cannot be rewritten');
    await expect(q(`INSERT INTO ortho_adjustments(id,case_id,visit_id,billing_class,followup_coverage_revision_id) VALUES($1,$1,$1,'INCLUDED',$2)`,[g.id,g.revision])).rejects.toThrow('cannot acquire');
  });
  it('freezes all signed proof-bearing clinical and billing fields, allowing no-op replay',async()=>{
    const f=await signed();
    for(const sql of ["UPDATE ortho_adjustments SET done='changed finding' WHERE id=$1",
      "UPDATE ortho_adjustments SET done_on='2026-10-21' WHERE id=$1",
      "UPDATE ortho_adjustments SET billing_decision='billed' WHERE id=$1",
      'UPDATE ortho_adjustments SET billing_invoice_id=100 WHERE id=$1'])
      await expect(q(sql,[f.id])).rejects.toThrow('Signed coverage adjustment cannot be rewritten');
    await q('UPDATE ortho_adjustments SET done=done WHERE id=$1',[f.id]);
  });
  it('refuses duplicate and mismatched manifests and direct proof truncation',async()=>{
    const f=await fixture();
    await expect(q(`INSERT INTO visits(id,patient_id,signed_at,signed_by,ortho_followup_coverage_proof) VALUES($1,$1,NOW(),'synthetic',$2)`,[f.id,JSON.stringify([f.tuple,f.tuple])])).rejects.toThrow('Duplicate');
    await expect(q(`INSERT INTO visits(id,patient_id,signed_at,signed_by,ortho_followup_coverage_proof) VALUES($1,$1,NOW(),'synthetic',$2)`,[f.id,JSON.stringify([{...f.tuple,patientId:99999}])])).rejects.toThrow('identity mismatch');
    await expect(q('TRUNCATE ortho_adjustments')).rejects.toThrow('cannot be truncated');
    await expect(q('TRUNCATE visits CASCADE')).rejects.toThrow();
  });
  it('preserves recorded owner while permitting current patient reassignment',async()=>{
    const f=await signed();
    await q('UPDATE visits SET patient_id=99999 WHERE id=$1',[f.id]);
    await q('UPDATE ortho_cases SET patient_id=99999 WHERE id=$1',[f.id]);
    expect((await q('SELECT ortho_followup_coverage_proof FROM visits WHERE id=$1',[f.id]))[0].ortho_followup_coverage_proof).toEqual([f.tuple]);
    const snapshot={format:1,case:[f.id,f.id],clinical:[f.id,f.id,f.id],plan:[f.id,f.id],item:[f.id,f.id,f.id],invoice:[f.id,f.id]};
    await q(`INSERT INTO ortho_followup_coverage_revisions
      (patient_id,ortho_case_id,clinical_case_id,plan_id,plan_item_id,invoice_id,version,supersedes_revision_id,scope,decision,source_fingerprint,source_snapshot,reason,actor_user_id,created_by,command_id,request_fingerprint)
      VALUES($1,$1,$1,$1,$1,$1,2,$2,'routine_adjustments','excluded',$3,$4,'Synthetic historical replay',1,'synthetic',$5,$3)`,
      [f.id,f.revision,'b'.repeat(64),JSON.stringify(snapshot),`10000000-0000-4000-8000-${String(f.id).padStart(12,'0')}`]);
  });
  it('supports multiple exact adjustment tuples in one visit',async()=>{
    const a=await fixture(),b=await fixture();
    // Recorded owners can share a patient while cases and revision streams differ.
    await q('INSERT INTO visits(id,patient_id) VALUES($1,$1)',[a.id]);
    await q(`INSERT INTO ortho_adjustments(id,case_id,visit_id,billing_class,followup_coverage_revision_id) VALUES($1,$1,$1,'INCLUDED',$2)`,[a.id,a.revision]);
    // Restore of historical manifest intentionally validates recorded owners, not
    // current merged visit ownership. Normal signature still checks current owner.
    await db.exec('BEGIN');
    try{
      await q(`INSERT INTO visits(id,patient_id,signed_at,signed_by,ortho_followup_coverage_proof) VALUES($1,99999,NOW(),'synthetic',$2)`,[b.id,JSON.stringify([{...a.tuple,adjustmentId:a.id+1000},b.tuple])]);
      await q(`INSERT INTO ortho_adjustments(id,case_id,visit_id,billing_class,followup_coverage_revision_id) VALUES($1,$2,$3,'INCLUDED',$4),($3,$3,$3,'INCLUDED',$5)`,[a.id+1000,a.id,b.id,a.revision,b.revision]);
      await db.exec('COMMIT');
    }catch(e){await db.exec('ROLLBACK');throw e;}
  });
});
