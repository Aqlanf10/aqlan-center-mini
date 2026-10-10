import {afterAll,beforeAll,beforeEach,expect,it} from "vitest";
import {openBackupTimestampFixture} from "./_backup-timestamp-fixture";
import type {SessionPayload} from "../../lib/auth";
let fixture:Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let db:typeof import("../../lib/db"),hr:typeof import("../../lib/hr"),work:typeof import("../../lib/hr-contracts-attendance");
let staffId:number;
const admin:SessionPayload={userId:1,username:"work-admin",role:"admin",expiresAt:Date.now()+3600000};
const reviewer:SessionPayload={...admin,userId:2,username:"work-reviewer"};
beforeAll(async()=>{
 fixture=await openBackupTimestampFixture(process.env);
 process.env.DATABASE_URL=fixture.source.options.connectionString!;
 process.env.SKIP_SEED="false";
 db=await import("../../lib/db");hr=await import("../../lib/hr");work=await import("../../lib/hr-contracts-attendance");
 await db.resetPoolForTesting();await db.ensureSchema();
 await db.getPool().query("INSERT INTO users(id,username,display_name,password_hash,role) VALUES (1,'work-admin','Admin','x','admin'),(2,'work-reviewer','Reviewer','x','admin') ON CONFLICT(id) DO NOTHING");
},30000);
beforeEach(async()=>{
 // Each case starts with no staff, contracts, attendance, leave or financial business rows.
 // Bootstrap the real schema once; fixed users/default types/settings are never changed by a case.
 await fixture.source.query("TRUNCATE hr_staff, hr_payroll_periods, cashier_shifts, expenses, payables, patients RESTART IDENTITY CASCADE");
 staffId=(await hr.createStaff({fullName:"Workforce fixture",department:"secretariat",jobTitle:"Reception",hireDate:"2026-01-01",workStatus:"active",contractKind:"salary",endDate:null,phone:null,note:null,payTerms:{amountMinor:80000,currency:"YER",period:"monthly",effectiveOn:"2026-01-01"}},admin)).id;
},30000);
afterAll(async()=>{await db?.resetPoolForTesting();await fixture?.close();});
it("a correction remains pending and leaves raw and actual punches unchanged until another admin approves",async()=>{
 const original=await work.recordAttendance({staffId,attendanceDate:"2026-08-01",checkIn:"2026-08-01T08:00:00+03:00",checkOut:"2026-08-01T16:00:00+03:00"},admin);
 const correction=await work.requestAttendanceCorrection({attendanceRecordId:original.id,fieldCorrected:"check_in",newCheckIn:"2026-08-01T09:00:00+03:00",reason:"Correction fixture"},admin);
 const pending=(await work.listAttendanceRecords({staffId}))[0];expect(pending.checkInActual).toBe(original.checkInActual);expect(correction).toMatchObject({status:"pending",approvedBy:null});
 await expect(work.decideAttendanceCorrection(correction.id,"approved",null,admin)).rejects.toThrow(/ذاتي/);
 await work.decideAttendanceCorrection(correction.id,"approved",null,reviewer);
 const approved=(await work.listAttendanceRecords({staffId}))[0];expect(approved.checkInRaw).toBe(original.checkInRaw);expect(approved.checkInActual).toBe("2026-08-01T06:00:00.000Z");
});
it("a night shift checkout joins its prior clinic date and preserves both punch events",async()=>{
 await work.createSchedule({staffId,name:"Night",scheduleType:"night",effectiveFrom:"2026-01-01",workingDays:[0,1,2,3,4,5,6],shiftStartTime:"22:00",shiftEndTime:"06:00",crossesMidnight:true},admin);
 await work.recordAttendancePunch({staffId,punchType:"check_in",punchTime:"2026-08-01T22:00:00+03:00"},admin);
 const out=await work.recordAttendancePunch({staffId,punchType:"check_out",punchTime:"2026-08-02T06:00:00+03:00"},admin);
 expect(out.attendanceDate).toBe("2026-08-01");expect(out.workMinutes).toBe(480);expect(out.lateMinutes).toBe(0);expect(out.isIncomplete).toBe(false);
 expect((await db.getPool().query("SELECT count(*)::int AS count FROM hr_attendance_punch_events WHERE attendance_id=$1",[out.id])).rows[0].count).toBe(2);
});
it("checkout without checkin is incomplete rather than a payable absence",async()=>{
 const out=await work.recordAttendancePunch({staffId,punchType:"check_out",punchTime:"2026-08-02T06:00:00+03:00"},admin);expect(out.isIncomplete).toBe(true);expect(out.status).toBe("incomplete");expect(out.workMinutes).toBe(0);
});
it("paid leave cannot be approved using an unapproved default entitlement",async()=>{
 const request=await work.createLeaveRequest({staffId,leaveTypeCode:"annual",startDate:"2026-08-10",endDate:"2026-08-10",daysCount:1,reason:"No owner allocation"},admin);
 await expect(work.decideLeaveRequest(request.id,"approved","Approve",reviewer)).rejects.toThrow(/رصيد/);
 expect((await work.listLeaveRequests({staffId}))[0].status).toBe("pending");expect(await work.listAttendanceRecords({staffId})).toHaveLength(0);
});
it("leave approval cannot overwrite an existing raw attendance record",async()=>{
 await work.adjustLeaveBalance({staffId,leaveTypeCode:"annual",year:2026,allocatedDays:10},admin);
 const original=await work.recordAttendance({staffId,attendanceDate:"2026-08-10",checkIn:"2026-08-10T08:00:00+03:00"},admin);
 const request=await work.createLeaveRequest({staffId,leaveTypeCode:"annual",startDate:"2026-08-10",endDate:"2026-08-10",daysCount:1,reason:"Conflict"},admin);
 await expect(work.decideLeaveRequest(request.id,"approved","Approve",reviewer)).rejects.toThrow(/حضور/);expect((await work.listAttendanceRecords({staffId}))[0]).toMatchObject({id:original.id,checkInRaw:original.checkInRaw,status:"incomplete"});
});
it("concurrent overlapping leave requests reserve days once",async()=>{
 await work.adjustLeaveBalance({staffId,leaveTypeCode:"annual",year:2026,allocatedDays:10},admin);
 const payload={staffId,leaveTypeCode:"annual" as const,startDate:"2026-08-10",endDate:"2026-08-10",daysCount:1,reason:"Concurrent fixture"};
 const outcomes=await Promise.allSettled([work.createLeaveRequest(payload,admin),work.createLeaveRequest(payload,admin)]);expect(outcomes.filter(x=>x.status==="fulfilled")).toHaveLength(1);expect((await work.listLeaveBalances(staffId,2026))[0].pendingDays).toBe(1);
});

it("a clinic user cannot read another staff member leave reasons or balances",async()=>{
 await work.adjustLeaveBalance({staffId,leaveTypeCode:"annual",year:2026,allocatedDays:10},admin);
 await work.createLeaveRequest({staffId,leaveTypeCode:"annual",startDate:"2026-08-10",endDate:"2026-08-10",daysCount:1,reason:"Private HR reason"},admin);
 const stranger:SessionPayload={...admin,userId:999,username:"stranger",role:"doctor"};
 expect(await work.listLeaveRequests({},stranger)).toEqual([]);
 expect(await work.listLeaveBalances(staffId,2026,stranger)).toEqual([]);
 await expect(work.createLeaveRequest({staffId,leaveTypeCode:"annual",startDate:"2026-08-11",endDate:"2026-08-11",daysCount:1,reason:"Tampered staff id"},stranger)).rejects.toThrow(/غير موجود/);
});
it("replaying an approved leave decision still enforces manager permission",async()=>{
 await work.adjustLeaveBalance({staffId,leaveTypeCode:"annual",year:2026,allocatedDays:10},admin);
 const request=await work.createLeaveRequest({staffId,leaveTypeCode:"annual",startDate:"2026-08-10",endDate:"2026-08-10",daysCount:1,reason:"Private approved reason"},admin);
 await work.decideLeaveRequest(request.id,"approved","Approved allocation",reviewer);
 const stranger:SessionPayload={...admin,userId:999,username:"stranger",role:"doctor"};
 await expect(work.decideLeaveRequest(request.id,"approved","Replay",stranger)).rejects.toThrow(/للمدير/);
});
it("an old cancelled request cannot be reapproved across another active request",async()=>{
 await work.adjustLeaveBalance({staffId,leaveTypeCode:"annual",year:2026,allocatedDays:10},admin);
 const input={staffId,leaveTypeCode:"annual" as const,startDate:"2026-08-10",endDate:"2026-08-10",daysCount:1,reason:"Overlap replay fixture"};
 const old=await work.createLeaveRequest(input,admin);await work.decideLeaveRequest(old.id,"cancelled","Cancel pending",reviewer);
 await work.createLeaveRequest(input,admin);
 await expect(work.decideLeaveRequest(old.id,"approved","Reapprove old",reviewer)).rejects.toThrow(/متداخل/);
 expect((await work.listLeaveBalances(staffId,2026))[0]).toMatchObject({usedDays:0,pendingDays:1});
});
it("concurrent approve and cancel decisions change balances and attendance exactly once",async()=>{
 await work.adjustLeaveBalance({staffId,leaveTypeCode:"annual",year:2026,allocatedDays:10},admin);
 const request=await work.createLeaveRequest({staffId,leaveTypeCode:"annual",startDate:"2026-08-10",endDate:"2026-08-11",daysCount:2,reason:"Concurrent decisions"},admin);
 await Promise.all([work.decideLeaveRequest(request.id,"approved","Approve",reviewer),work.decideLeaveRequest(request.id,"approved","Approve",reviewer)]);
 expect((await work.listLeaveBalances(staffId,2026))[0]).toMatchObject({usedDays:2,pendingDays:0,availableDays:8});expect(await work.listAttendanceRecords({staffId})).toHaveLength(2);
 await Promise.all([work.decideLeaveRequest(request.id,"cancelled","Cancel",reviewer),work.decideLeaveRequest(request.id,"cancelled","Cancel",reviewer)]);
 expect((await work.listLeaveBalances(staffId,2026))[0]).toMatchObject({usedDays:0,pendingDays:0,availableDays:10});expect(await work.listAttendanceRecords({staffId})).toHaveLength(0);
});
it("leave audit failure rolls back decision, balance and attendance together",async()=>{
 await work.adjustLeaveBalance({staffId,leaveTypeCode:"annual",year:2026,allocatedDays:10},admin);
 const request=await work.createLeaveRequest({staffId,leaveTypeCode:"annual",startDate:"2026-08-10",endDate:"2026-08-10",daysCount:1,reason:"Audit rollback"},admin);
 await db.getPool().query("CREATE FUNCTION workforce_audit_fail() RETURNS trigger AS $$ BEGIN IF NEW.action='hr.leave.decision' THEN RAISE EXCEPTION 'synthetic leave audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql");
 await db.getPool().query("CREATE TRIGGER workforce_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION workforce_audit_fail()");
 try{await expect(work.decideLeaveRequest(request.id,"approved","Approve",reviewer)).rejects.toThrow("synthetic leave audit failure");}
 finally{await db.getPool().query("DROP TRIGGER workforce_audit_fail ON audit_log");await db.getPool().query("DROP FUNCTION workforce_audit_fail()");}
 expect((await work.listLeaveRequests({staffId}))[0].status).toBe("pending");expect((await work.listLeaveBalances(staffId,2026))[0]).toMatchObject({usedDays:0,pendingDays:1});expect(await work.listAttendanceRecords({staffId})).toHaveLength(0);
});

it("legacy single-voucher HR payouts cannot be reversed through the generic expense entrypoint",async()=>{
 const payroll=await import("../../lib/hr-payroll");await db.openShift({openedBy:admin.username,opening:{YER:0,SAR:0,USD:0}});
 const period=await payroll.getOrCreatePayrollPeriod("2026-08",admin),run=await payroll.calculatePayrollRun(period.id,"YER",admin);await payroll.approvePayrollRun(run.id,admin);
 const item=(await payroll.listPayrollItems(run.id))[0];
 const paid=await payroll.disbursePayrollItem(item.id,{amountMinor:10,clientRequestId:"legacy-void-fixture-1"},admin);
 // Reproduce the old 0049 row shape: one linked voucher, before component rows existed.
 // The original immutable expense remains untouched; only this owned fixture's new linking rows are removed.
 await db.getPool().query("DELETE FROM hr_payroll_disbursement_parts WHERE disbursement_id=$1",[paid.id]);
 await expect(db.voidExpense(paid.expenseId!,{actor:admin.username,actorRole:admin.role,reason:"Generic legacy reversal"})).rejects.toThrow(/المسير/);
 expect((await payroll.listPayrollItems(run.id))[0].paidMinor).toBe(10);
});
it("an unreconciled legacy hybrid claim blocks unlinked doctor commission payments",async()=>{
 const payroll=await import("../../lib/hr-payroll"),pool=db.getPool();
 const party=(await pool.query("INSERT INTO parties(name,kind,commission_percent) VALUES ('Legacy hybrid doctor','doctor',30) RETURNING id")).rows[0];
 const contract=await work.createContract({staffId,templateKind:"doctor_hybrid",title:"Legacy hybrid fixture",startDate:"2026-01-01",compensationKind:"salary_commission",baseSalaryMinor:80000,salaryCurrency:"YER",salaryPeriod:"monthly",doctorPartyId:party.id,commissionRatePercent:30},admin);await work.transitionContractStatus(contract.id,"active","Explicit contract fixture",admin);
 const shift=await db.openShift({openedBy:admin.username,opening:{YER:0,SAR:0,USD:0}});
 const patient=(await pool.query("INSERT INTO patients(patient_number,full_name) VALUES ('LEGACY-HR','Synthetic legacy patient') RETURNING id")).rows[0];
 const invoice=(await pool.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency,created_by,created_at) VALUES ('LEGACY-HR-I',$1,40000,'YER','work-admin','2026-08-02 10:00+03') RETURNING id",[patient.id])).rows[0];
 await pool.query("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor,doctor_id) VALUES ($1,'Synthetic legacy service',1,40000,40000,$2)",[invoice.id,party.id]);
 await pool.query("INSERT INTO visits(patient_name,patient_id,doctor_id,status,invoice_id,arrived_at,signed_at,signed_by) VALUES ('Synthetic legacy patient',$1,$2,'done',$3,'2026-08-02 10:00+03','2026-08-02 10:00+03','work-admin')",[patient.id,party.id,invoice.id]);
 await pool.query("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by,created_at) VALUES ('LEGACY-HR-R',$1,$2,$3,'payment',40000,'YER',1,40000,'YER','cash','work-admin','2026-08-02 10:00+03')",[patient.id,invoice.id,shift!.id]);
 const period=await payroll.getOrCreatePayrollPeriod("2026-08",admin),run=await payroll.calculatePayrollRun(period.id,"YER",admin);await payroll.approvePayrollRun(run.id,admin);
 const item=(await payroll.listPayrollItems(run.id))[0];expect(item.commissionsMinor).toBe(12000);
 // Legacy approved items had no commission payable or snapshot. Do not guess a backfill.
 await pool.query("UPDATE hr_payroll_items SET commission_payable_id=NULL,pay_terms_snapshot='{}' WHERE id=$1",[item.id]);
 const paid=await db.recordExpense({category:"commission",partyId:party.id,payeeText:null,amountMinor:12000,currency:"YER",baseCurrency:"YER",exchangeRate:1,payableId:null,note:"Unlinked legacy payment",createdBy:admin.username});
 expect(paid.expense).toBeNull();expect(paid.reason).toBe("hr_payroll_reconciliation_required");
 expect((await db.commissionReport("2026-08-01","2026-08-31")).find(row=>row.doctorId===party.id)?.dueMinor).toBe(12000);
 expect(Number((await pool.query("SELECT COALESCE(SUM(amount_minor),0) AS out FROM expenses WHERE shift_id=$1",[shift!.id])).rows[0].out)).toBe(0);
});
