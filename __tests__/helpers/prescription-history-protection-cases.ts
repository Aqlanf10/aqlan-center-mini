import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
export function prescriptionHistoryProtectionCases(db: typeof import('../../lib/db')) {
 const query = async (sql: string, values: unknown[] = []) => db.getPool().query(sql, values);
 const patient = async () => (await query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic protected history') RETURNING id", [`SYN-${randomUUID()}`])).rows[0].id as number;
 const visit = async (patientId: number) => (await query("INSERT INTO visits(patient_id,patient_name) VALUES($1,'Synthetic visit') RETURNING id", [patientId])).rows[0].id as number;
 const prescription = async (patientId: number, visitId: number | null, command: boolean, status = 'active') => {
  const { rows: [rx] } = await query("INSERT INTO prescriptions(patient_id,visit_id,items,created_by,status) VALUES($1,$2,'[]','synthetic-protection',$3) RETURNING id", [patientId,visitId,status]);
  if (command) await query("INSERT INTO prescription_issuance_commands(command_key,actor_user_id,actor_username,patient_id,visit_id,payload_sha256,prescription_id) VALUES($1,1,'synthetic-protection',$2,$3,$4,$5)", [randomUUID(),patientId,visitId,'a'.repeat(64),rx.id]);
  return rx.id as number;
 };
 it.each(['active','void'])('refuses receipt-bearing source merge without partial mutations (%s)', async status => {
  const source = await patient(), target = await patient(), sourceVisit = await visit(source), rx = await prescription(source, sourceVisit, true, status);
  const before = (await query('SELECT to_jsonb(p)::text row FROM patients p WHERE id=ANY($1::int[]) ORDER BY id', [[source,target]])).rows;
  expect(await db.mergeDuplicatePatient(source,target,{actor:'synthetic-protection'})).toMatchObject({ok:false,reason:'source_has_prescription_history',counts:{prescriptionCommands:1}});
  expect((await query('SELECT to_jsonb(p)::text row FROM patients p WHERE id=ANY($1::int[]) ORDER BY id', [[source,target]])).rows).toEqual(before);
  expect((await query('SELECT patient_id,visit_id FROM prescriptions WHERE id=$1',[rx])).rows[0]).toEqual({patient_id:source,visit_id:sourceVisit});
 });
 it('allows target-only receipt history and retains legacy source Rx merge behavior', async () => {
  const source=await patient(),target=await patient(); const legacyRx=await prescription(source,null,false),targetRx=await prescription(target,null,true);
  expect(await db.mergeDuplicatePatient(source,target,{actor:'synthetic-protection'})).toMatchObject({ok:true});
  expect((await query('SELECT patient_id FROM prescriptions WHERE id=ANY($1::int[]) ORDER BY id',[[legacyRx,targetRx]])).rows).toEqual([{patient_id:target},{patient_id:target}]);
 });
 it('refuses delete or patient reparent for a command-bearing visit, but permits same-patient link', async () => {
  const source=await patient(),target=await patient(),sourceVisit=await visit(source); const rx=await prescription(source,sourceVisit,true);
  expect(await db.deleteVisit(sourceVisit,{actor:'synthetic-protection'})).toEqual({ok:false,reason:'has_prescription_history'});
  expect(await db.linkVisitToPatient(sourceVisit,target)).toMatchObject({ok:false});
  expect(await db.linkVisitToPatient(sourceVisit,source)).toMatchObject({ok:true});
  expect((await query('SELECT patient_id FROM visits WHERE id=$1',[sourceVisit])).rows[0]).toEqual({patient_id:source});
  expect((await query('SELECT patient_id,visit_id FROM prescriptions WHERE id=$1',[rx])).rows[0]).toEqual({patient_id:source,visit_id:sourceVisit});
 });
 it('preserves operational visit relink and deletion when no command history exists', async () => {
  const source=await patient(),target=await patient(),sourceVisit=await visit(source);
  expect(await db.linkVisitToPatient(sourceVisit,target)).toMatchObject({ok:true});
  expect(await db.deleteVisit(sourceVisit,{actor:'synthetic-protection'})).toEqual({ok:true});
 });
}
