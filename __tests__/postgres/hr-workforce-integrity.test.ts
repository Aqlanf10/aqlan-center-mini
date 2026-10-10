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
},30000);
beforeEach(async()=>{
 await db.resetPoolForTesting();
 // The URL here is our identity-checked disposable fixture, never the supplied test database.
 await fixture.source.query("DROP SCHEMA public CASCADE");await fixture.source.query("CREATE SCHEMA public");await db.ensureSchema();
 await db.getPool().query("INSERT INTO users(id,username,display_name,password_hash,role) VALUES (1,'work-admin','Admin','x','admin'),(2,'work-reviewer','Reviewer','x','admin') ON CONFLICT(id) DO NOTHING");
 staffId=(await hr.createStaff({fullName:"Workforce fixture",department:"secretariat",jobTitle:"Reception",hireDate:"2026-01-01",workStatus:"active",contractKind:"salary",endDate:null,phone:null,note:null,payTerms:{amountMinor:80000,currency:"YER",period:"monthly",effectiveOn:"2026-01-01"}},admin )).id;
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
