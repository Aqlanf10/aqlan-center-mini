import type { Pool } from "pg";
export async function seedCanonicalOrthoFollowups(q: Pick<Pool, "query">, doctor: number, otherDoctor: number, today: string) {
  const patient = (await q.query("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-OF','SYN followup patient','SYN private phone',$1) RETURNING id", [doctor])).rows[0].id;
  const outside = (await q.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-OF-OUT','SYN outside patient') RETURNING id")).rows[0].id;
  const caseId = (await q.query("INSERT INTO ortho_cases(patient_id,start_date,created_by,note) VALUES($1,'2024-01-01','SYN','SYN private case note') RETURNING id", [patient])).rows[0].id;
  const outsideCase = (await q.query("INSERT INTO ortho_cases(patient_id,start_date,created_by) VALUES($1,'2024-01-01','SYN') RETURNING id", [outside])).rows[0].id;
  const adjustment = (await q.query("INSERT INTO ortho_adjustments(case_id,done_on,next_weeks,recorded_by,note) VALUES($1,'2024-02-01',4,'SYN','SYN private adjustment') RETURNING id", [caseId])).rows[0].id;
  const make = async (provider: number, status: string, type: string, time: string) => Number((await q.query(`INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status,doctor_id,appointment_type,note)
    VALUES($1,$2,$3,$4,$5,$6,'SYN private booking note') RETURNING id`, [patient, today, time, status, provider, type])).rows[0].id);
  const ownBooking = await make(doctor, "booked", "follow_up", "10:00");
  const otherBooking = await make(otherDoctor, "booked", "follow_up", "11:00");
  const missed = await make(otherDoctor, "no_show", "follow_up", "09:00");
  const unknown = await make(doctor, "booked", "", "12:00");
  return { patient: Number(patient), outside: Number(outside), caseId: Number(caseId), outsideCase: Number(outsideCase), adjustment: Number(adjustment), ownBooking, otherBooking, missed, unknown };
}
