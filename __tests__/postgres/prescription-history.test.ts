import { afterEach, beforeEach, expect, it } from 'vitest';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { querySavedPrescriptionHistory } from '../../lib/prescription-history';
import { decodePrescriptionPrintCursor } from '../../lib/prescription-print-pagination';
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
beforeEach(async () => {
 fixture = await openBackupTimestampFixture(process.env);
 await fixture.source.query(`CREATE TABLE prescriptions(id SERIAL PRIMARY KEY, patient_id INT, visit_id INT, created_at TIMESTAMPTZ, prescribing_doctor_name TEXT, status TEXT, items JSONB, void_reason TEXT)`);
});
afterEach(async () => { await fixture?.close(); });
const read = (patientId = 7, visitId: number | null = null, cursor: string | null = null) => querySavedPrescriptionHistory(fixture.source, patientId, visitId, decodePrescriptionPrintCursor(cursor, patientId, visitId), 'Asia/Aden');
it('isolates patients/visits, retains legacy/void snapshots, and never depends on visit open state', async () => {
 const items = [{ name: 'SyntheticRx', dose: '500mg', selection: { id: 'manual', amount: '1 tablet', confirmed: true }, instructions: 'تعليمات أصلية' }];
 await fixture.source.query(`INSERT INTO prescriptions(patient_id,visit_id,created_at,status,items,void_reason) VALUES (7,9,'2026-10-31T22:30:00.123456Z','void',$1,'Synthetic void'),(7,10,'2026-10-31T22:30:00.123457Z','active',$1,NULL),(8,9,'2026-10-31T22:30:00.123458Z','active',$1,NULL)`, [JSON.stringify(items)]);
 const page = await read(7, 9); expect(page.prescriptions).toHaveLength(1);
 expect(page.prescriptions[0]).toMatchObject({ status: 'void', prescribingDoctorName: null, visitId: 9, voidReason: 'Synthetic void', items: [{ name: 'SyntheticRx', dose: '500mg', selection: { amount: '1 tablet' }, instructions: 'تعليمات أصلية' }] });
 expect(page.prescriptions[0].createdAtLabel).toContain('01'); expect(page.nextCursor).toBeNull();
 expect((await read(7)).prescriptions).toHaveLength(2); expect((await read(8)).prescriptions).toHaveLength(1);
});
it('paginates 50/51 with equal timestamps and full microseconds without duplicates or loss', async () => {
 await fixture.source.query(`INSERT INTO prescriptions(patient_id,visit_id,created_at,status,items) SELECT 7,9,'2026-10-31T22:30:00.123456Z'::timestamptz,CASE WHEN n%2=0 THEN 'void' ELSE 'active' END,'[]'::jsonb FROM generate_series(1,51) n`);
 const first = await read(7, 9); expect(first.prescriptions).toHaveLength(50); expect(first.nextCursor).toBeTruthy();
 expect(decodePrescriptionPrintCursor(first.nextCursor, 7, 9)?.createdAt).toBe('2026-10-31T22:30:00.123456Z');
 const second = await read(7, 9, first.nextCursor); expect(second.prescriptions).toHaveLength(1); expect(second.nextCursor).toBeNull();
 expect(new Set([...first.prescriptions, ...second.prescriptions].map(row => row.id)).size).toBe(51);
});
