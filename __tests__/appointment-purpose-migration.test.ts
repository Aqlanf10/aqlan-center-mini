import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { APPOINTMENT_PURPOSE_PROVENANCE_SQL, APPOINTMENT_PURPOSE_PROVENANCE_SHA256 } from '../lib/appointment-purpose-schema';
import { APPOINTMENT_PURPOSE_MIGRATION, validateAppointmentPurposeMigration } from '../lib/appointment-purpose-migration-guard';
import { checksumOf } from '../lib/migration-files';
import { insertAppointmentPurposeProvenance } from '../lib/appointment-purpose';

const sqlFile = new URL('../migrations/0095_appointment_purpose_provenance.sql', import.meta.url);
const fresh = async () => {
  const db = new PGlite();
  await db.exec(`CREATE TABLE patients(id INTEGER PRIMARY KEY);
    CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE appointments(id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id), planned_visit_id INTEGER);
    CREATE TABLE treatment_plans(id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id));
    CREATE TABLE planned_visits(id INTEGER PRIMARY KEY,patient_id INTEGER NOT NULL REFERENCES patients(id),plan_id INTEGER NOT NULL REFERENCES treatment_plans(id));
    INSERT INTO patients VALUES(19),(20);
    INSERT INTO users VALUES(1,'synthetic-actor'),(2,'other-actor');
    INSERT INTO appointments VALUES(101,19,501),(102,19,NULL),(103,19,NULL);
    INSERT INTO treatment_plans VALUES(301,19),(302,20);
    INSERT INTO planned_visits VALUES(501,19,301),(502,20,302);`);
  return db;
};
const applied = [{version:'0095',name:'appointment_purpose_provenance',checksum:APPOINTMENT_PURPOSE_PROVENANCE_SHA256,adopted:false}];
describe('0095 appointment provenance source and database guard', () => {
 it('keeps versioned runtime SQL byte-identical with the CLI migration', () => {
   const source=readFileSync(sqlFile,'utf8');
   expect(APPOINTMENT_PURPOSE_PROVENANCE_SQL).toBe(source);
   expect(checksumOf(source)).toBe(APPOINTMENT_PURPOSE_PROVENANCE_SHA256);
   expect(APPOINTMENT_PURPOSE_MIGRATION.checksum).toBe(checksumOf(source));
 }, 30000);
 it('rejects unregistered partial catalog before DDL', async () => {
   const db=await fresh();
   try {
     await db.exec('CREATE TABLE appointment_purpose_provenance(id integer)');
     await expect(validateAppointmentPurposeMigration(db as never,[APPOINTMENT_PURPOSE_MIGRATION],[])).rejects.toThrow('unregistered residue');
   } finally {await db.close();}
 }, 30000);
 it('rejects registry drift before DDL', async () => {
   const db=await fresh();
   try {await expect(validateAppointmentPurposeMigration(db as never,[APPOINTMENT_PURPOSE_MIGRATION],[{...applied[0],checksum:'tampered'}])).rejects.toThrow('REGISTRY_MISMATCH');}
   finally {await db.close();}
 }, 30000);
 it('requires a committed direct-command receipt tuple and rejects UUID reuse or foreign actor', async () => {
   const db=await fresh();
   const commandId='312dd164-3a68-4b13-98b2-92c41bd7d469', hash='a'.repeat(64);
   try {
     await db.exec(APPOINTMENT_PURPOSE_PROVENANCE_SQL);
     await expect(db.query(`INSERT INTO appointment_purpose_provenance
       (appointment_id,patient_id,purpose,recorded_by)
       VALUES(102,19,'consultation','synthetic-actor')`)).rejects.toThrow();
     await expect(db.query(`INSERT INTO appointment_purpose_provenance
       (appointment_id,patient_id,purpose,recorded_by,command_id,actor_user_id)
       VALUES(102,19,'consultation','synthetic-actor',$1,1)`,[commandId])).rejects.toThrow();
     await expect(db.query(`INSERT INTO appointment_purpose_provenance
       (appointment_id,patient_id,purpose,recorded_by,command_id,command_hash,actor_user_id)
       VALUES(102,19,'consultation','synthetic-actor',$1,$2,999)`,[commandId,hash])).rejects.toThrow();
     await db.query(`INSERT INTO appointment_purpose_provenance
       (appointment_id,patient_id,purpose,recorded_by,command_id,command_hash,actor_user_id)
       VALUES(102,19,'consultation','synthetic-actor',$1,$2,1)`,[commandId,hash]);
     await expect(db.query(`INSERT INTO appointment_purpose_provenance
       (appointment_id,patient_id,purpose,recorded_by,command_id,command_hash,actor_user_id)
       VALUES(103,19,'consultation','synthetic-actor',$1,$2,1)`,[commandId,hash])).rejects.toThrow();
     await expect(db.query(`UPDATE appointment_purpose_provenance SET command_hash=$1 WHERE appointment_id=102`,['b'.repeat(64)]))
       .rejects.toThrow('immutable');
   } finally {await db.close();}
 }, 30000);
 it('rejects a standalone unregistered index residue before DDL', async () => {
   const db=await fresh();
   try {
     await db.exec('CREATE INDEX appointment_purpose_patient_time_idx ON patients(id)');
     await expect(validateAppointmentPurposeMigration(db as never,[APPOINTMENT_PURPOSE_MIGRATION],[])).rejects.toThrow('unregistered residue');
   } finally {await db.close();}
 }, 30000);
 it('rejects immutable-function security and conditional-trigger tampering', async () => {
   const db=await fresh();
   try {
     await db.exec(APPOINTMENT_PURPOSE_PROVENANCE_SQL);
     await db.exec('ALTER FUNCTION aqlan_appointment_purpose_immutable() SECURITY DEFINER');
     await expect(validateAppointmentPurposeMigration(db as never,[APPOINTMENT_PURPOSE_MIGRATION],applied)).rejects.toThrow('immutable function metadata');
     await db.exec('ALTER FUNCTION aqlan_appointment_purpose_immutable() SECURITY INVOKER');
     await db.exec(`DROP TRIGGER appointment_purpose_immutable ON appointment_purpose_provenance;
       CREATE TRIGGER appointment_purpose_immutable BEFORE UPDATE OR DELETE ON appointment_purpose_provenance
       FOR EACH ROW WHEN (false) EXECUTE FUNCTION aqlan_appointment_purpose_immutable()`);
     await expect(validateAppointmentPurposeMigration(db as never,[APPOINTMENT_PURPOSE_MIGRATION],applied)).rejects.toThrow('appointment_purpose_immutable');
   } finally {await db.close();}
 }, 30000);
 it('rejects a changed purpose literal even when the CHECK name is unchanged', async () => {
   const db=await fresh();
   try {
     await db.exec(APPOINTMENT_PURPOSE_PROVENANCE_SQL);
     await db.exec(`ALTER TABLE appointment_purpose_provenance
       DROP CONSTRAINT appointment_purpose_provenance_purpose_check;
       ALTER TABLE appointment_purpose_provenance ADD CONSTRAINT appointment_purpose_provenance_purpose_check
       CHECK (purpose IN ('consultation','start_treatment','continue_session','try_in','delivery','FOLLOW_UP'))`);
     await expect(validateAppointmentPurposeMigration(db as never,[APPOINTMENT_PURPOSE_MIGRATION],applied))
       .rejects.toThrow('appointment_purpose_provenance_purpose_check');
   } finally {await db.close();}
 }, 30000);
 it('enforces immutable origin, same patient and plan, and nonempty reset refusal', async () => {
   const db=await fresh();
   try {
     await db.exec(APPOINTMENT_PURPOSE_PROVENANCE_SQL);
     await validateAppointmentPurposeMigration(db as never,[APPOINTMENT_PURPOSE_MIGRATION],applied);
     await expect(db.query(`INSERT INTO appointment_purpose_provenance(appointment_id,patient_id,purpose,source_plan_id,source_planned_visit_id,recorded_by)
       VALUES(101,19,'follow_up',302,502,'test')`)).rejects.toThrow();
     await db.query(`INSERT INTO appointment_purpose_provenance(appointment_id,patient_id,purpose,source_plan_id,source_planned_visit_id,recorded_by)
       VALUES(101,19,'follow_up',301,501,'test')`);
     await expect(db.exec('UPDATE appointment_purpose_provenance SET purpose=\'delivery\'')).rejects.toThrow('immutable');
     await expect(db.exec('TRUNCATE appointment_purpose_provenance')).rejects.toThrow('immutable');
     await expect(db.exec('DELETE FROM planned_visits WHERE id=501')).rejects.toThrow();
     await expect(db.exec('UPDATE treatment_plans SET patient_id=20 WHERE id=301')).rejects.toThrow();
   } finally {await db.close();}
 }, 30000);
 it('does not write direct intent onto a planned appointment or plan intent without the same live visit', async () => {
   const db=await fresh();
   try {
     await db.exec(APPOINTMENT_PURPOSE_PROVENANCE_SQL);
     await expect(insertAppointmentPurposeProvenance(db as never,{appointmentId:101,purpose:'consultation',
       sourcePlanId:null,sourcePlannedVisitId:null,recordedBy:'test'})).rejects.toThrow('ORIGIN_STALE');
     await expect(insertAppointmentPurposeProvenance(db as never,{appointmentId:101,purpose:'follow_up',
       sourcePlanId:301,sourcePlannedVisitId:502,recordedBy:'test'})).rejects.toThrow('ORIGIN_STALE');
     await insertAppointmentPurposeProvenance(db as never,{appointmentId:101,purpose:'follow_up',
       sourcePlanId:301,sourcePlannedVisitId:501,recordedBy:'test'});
     expect((await db.query('SELECT purpose,source_plan_id FROM appointment_purpose_provenance')).rows).toMatchObject([
       {purpose:'follow_up',source_plan_id:301},
     ]);
   } finally {await db.close();}
 }, 30000);
});
