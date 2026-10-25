import type { Client } from "pg";

/** Own only these synthetic duty rows in the isolated HTTP database. */
export async function seedAdvisoryDuty(db: Client, doctorId: number, from: string, to = from) {
  const marker = `synthetic-advisory-${from}`;
  const { rows: [account] } = await db.query<{ id: number }>("SELECT id FROM users WHERE party_id=$1", [doctorId]);
  if (!account) throw new Error("Synthetic doctor account missing");
  const { rows: [staff] } = await db.query<{ id: number }>(`INSERT INTO hr_staff(full_name,user_id,department,created_by)
    VALUES('Private synthetic HR name',$1,'doctors',$2) RETURNING id`, [account.id, marker]);
  const { rows: [schedule] } = await db.query<{ id: number }>(`INSERT INTO hr_work_schedules(staff_id,name,effective_from,effective_to,
    working_days,shift_start_time,shift_end_time,schedule_type,created_by)
    VALUES($1,'Private synthetic schedule',$2::date-1,$3::date,'[0,1,2,3,4,5,6]','09:00','13:00','morning',$4) RETURNING id`,
  [staff.id, from, to, marker]);
  return { staffId: staff.id, scheduleId: schedule.id, cleanup: async () => {
    await db.query("DELETE FROM hr_work_schedules WHERE id=$1 AND staff_id=$2 AND created_by=$3", [schedule.id, staff.id, marker]);
    await db.query("DELETE FROM hr_staff WHERE id=$1 AND created_by=$2", [staff.id, marker]);
  } };
}
