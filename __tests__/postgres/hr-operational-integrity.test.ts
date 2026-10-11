/** Desired behavior regressions, derived from the retained owner-audit probes. */
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {openBackupTimestampFixture} from './_backup-timestamp-fixture';
import type {SessionPayload} from '../../lib/auth';
let fixture:Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let db:typeof import('../../lib/db'),hr:typeof import('../../lib/hr'),work:typeof import('../../lib/hr-contracts-attendance'),pay:typeof import('../../lib/hr-payroll');
let admin:SessionPayload,reviewer:SessionPayload,staffId:number;
beforeAll(async()=>{
 fixture=await openBackupTimestampFixture(process.env);process.env.DATABASE_URL=fixture.source.options.connectionString!;process.env.SKIP_SEED='false';
 db=await import('../../lib/db');await db.resetPoolForTesting();await db.ensureSchema();
 hr=await import('../../lib/hr');work=await import('../../lib/hr-contracts-attendance');pay=await import('../../lib/hr-payroll');
 const {sessionCredentialVersion}=await import('../../lib/auth');
 const {rows}=await db.getPool().query("INSERT INTO users(username,display_name,password_hash,role) VALUES ('audit-manager','Audit Manager','synthetic-only','admin'),('audit-reviewer','Audit Reviewer','synthetic-only','admin') RETURNING *");
 [admin,reviewer]=rows.map(r=>({userId:r.id,username:r.username,role:r.role,expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion(r.password_hash)}));
},30000);
beforeEach(async()=>{
 await fixture.source.query('TRUNCATE hr_staff,hr_payroll_periods,cashier_shifts,expenses,payables,patients RESTART IDENTITY CASCADE');
 await fixture.source.query("UPDATE hr_settings SET value='{\"late_grace_mins\":15,\"overtime_rate_multiplier\":1.5,\"late_deduction_rate_per_hour\":1}'::jsonb WHERE key='attendance_policy'");
 staffId=(await hr.createStaff({fullName:'موظف تدقيق اصطناعي',department:'secretariat',jobTitle:'استقبال',hireDate:'2026-01-01',endDate:null,workStatus:'active',contractKind:'salary',phone:null,note:null,payTerms:{amountMinor:100000,currency:'YER',period:'monthly',effectiveOn:'2026-01-01'}},admin)).id;
});
afterAll(async()=>{await db?.resetPoolForTesting();await fixture?.close();});

it('counts both split-shift pairs without the unpaid gap or duplicate punches',async()=>{
 await work.createSchedule({staffId,name:'Split',scheduleType:'split',effectiveFrom:'2026-01-01',workingDays:[0,1,2,3,4,5,6],shiftStartTime:'08:00',shiftEndTime:'12:00',secondShiftStart:'16:00',secondShiftEnd:'20:00'},admin);
 let record:any;
 for(const [punchType,time] of [['check_in','08:00'],['check_out','12:00'],['check_in','16:00'],['check_out','20:00'],['check_out','20:00']] as const)record=await work.recordAttendancePunch({staffId,punchType,punchTime:`2026-08-01T${time}:00+03:00`},admin);
 expect(record).toMatchObject({workMinutes:480,lateMinutes:0,earlyExitMinutes:0,isIncomplete:false});
 expect((await db.getPool().query('SELECT * FROM hr_attendance_punch_events WHERE staff_id=$1',[staffId])).rows).toHaveLength(5);
});
it('anchors a first after-midnight night punch to the preceding clinic date',async()=>{
 await work.createSchedule({staffId,name:'Night',scheduleType:'night',effectiveFrom:'2026-01-01',workingDays:[0,1,2,3,4,5,6],shiftStartTime:'22:00',shiftEndTime:'06:00',crossesMidnight:true,gracePeriodMins:15},admin);
 await work.recordAttendancePunch({staffId,punchType:'check_in',punchTime:'2026-08-02T01:00:00+03:00'},admin);
 const record=await work.recordAttendancePunch({staffId,punchType:'check_out',punchTime:'2026-08-02T06:00:00+03:00'},admin);
 expect(record).toMatchObject({attendanceDate:'2026-08-01',workMinutes:300,lateMinutes:180,earlyExitMinutes:0,overtimeMinutes:0});
});
it('refuses undated suspension recalculation and approval without deleting the previous draft',async()=>{
 const period=await pay.getOrCreatePayrollPeriod('2026-08',admin);const before=await pay.calculatePayrollRun(period.id,'YER',admin);
 const items=await pay.listPayrollItems(before.id);expect(before.totalNetDueMinor).toBe(100000);
 await hr.updateStaff(staffId,{workStatus:'suspended',reason:'Current suspension has no effective-date history'},admin);
 await expect(pay.calculatePayrollRun(period.id,'YER',admin)).rejects.toMatchObject({code:'employment_history_required'});
 expect(await pay.listPayrollItems(before.id)).toEqual(items);
 expect((await pay.getPayrollRunById(before.id))?.totalNetDueMinor).toBe(100000);
 await expect(pay.approvePayrollRun(before.id,admin)).rejects.toMatchObject({code:'employment_history_required'});
 expect((await db.getPool().query('SELECT * FROM payables')).rows).toHaveLength(0);
});
it('required attachment blocks leave approval atomically until a reference is supplied',async()=>{
 await work.adjustLeaveBalance({staffId,leaveTypeCode:'sick',year:2026,allocatedDays:3},admin);
 const request=await work.createLeaveRequest({staffId,leaveTypeCode:'sick',startDate:'2026-08-10',endDate:'2026-08-10',daysCount:1,reason:'Synthetic leave',attachmentRefs:[]},admin);
 const before=await work.listLeaveBalances(staffId,2026);
 await expect(work.decideLeaveRequest(request.id,'approved','Review',reviewer)).rejects.toThrow(/مرفق/);
 expect(await work.listLeaveBalances(staffId,2026)).toEqual(before);
 expect(await work.listAttendanceRecords({staffId})).toHaveLength(0);
 await work.decideLeaveRequest(request.id,'cancelled','Replace incomplete submission',reviewer);
 const documented=await work.createLeaveRequest({staffId,leaveTypeCode:'sick',startDate:'2026-08-10',endDate:'2026-08-10',daysCount:1,reason:'Synthetic documented leave',attachmentRefs:[{id:'synthetic-local-document',name:'مستند اصطناعي مقدم للمراجع'}]},admin);
 expect((await work.decideLeaveRequest(documented.id,'approved','Review',reviewer)).status).toBe('approved');
});
it('rejects invalid settings atomically and keeps the canonical previous policy',async()=>{
 const before=await pay.getHrSettings();
 await expect(pay.updateHrSettings({attendancePolicy:{lateGraceMins:-500,lateDeductionRatePerHour:-1,overtimeRateMultiplier:-1}},admin)).rejects.toMatchObject({code:'invalid_setting',status:400});
 expect(await pay.getHrSettings()).toEqual(before);
 expect(before.attendancePolicy?.lateGraceMins).toBe(15);
});
it('freezes a used schedule and keeps exact punch replay from reinterpreting stored history',async()=>{
 const schedule=await work.createSchedule({staffId,name:'Original',scheduleType:'morning',effectiveFrom:'2026-01-01',workingDays:[0,1,2,3,4,5,6],shiftStartTime:'08:00',shiftEndTime:'16:00',gracePeriodMins:15},admin);
 await work.recordAttendancePunch({staffId,punchType:'check_in',punchTime:'2026-08-01T08:30:00+03:00'},admin);
 const before=await work.recordAttendancePunch({staffId,punchType:'check_out',punchTime:'2026-08-01T16:00:00+03:00'},admin);
 await expect(work.updateWorkSchedule(schedule.id,{shiftStartTime:'09:00',shiftEndTime:'17:00'},admin)).rejects.toThrow(/مستخدم|تاريخ/);
 const replay=await work.recordAttendancePunch({staffId,punchType:'check_out',punchTime:'2026-08-01T16:00:00+03:00'},admin);
 expect(replay).toMatchObject({lateMinutes:30,checkInRaw:before.checkInRaw,scheduleId:before.scheduleId});
});
it('new schedules snapshot the saved default grace while existing schedules and explicit overrides remain unchanged',async()=>{
 const input={staffId,name:'Policy',scheduleType:'morning' as const,effectiveFrom:'2026-01-01',workingDays:[0,1,2,3,4,5,6],shiftStartTime:'08:00',shiftEndTime:'16:00'};
 const old=await work.createSchedule(input,admin);
 await pay.updateHrSettings({attendancePolicy:{lateGraceMins:90,lateDeductionRatePerHour:0,overtimeRateMultiplier:1}},admin);
 const next=await work.createSchedule({...input,effectiveFrom:'2026-08-01'},admin);
 expect(next.gracePeriodMins).toBe(90);expect((await work.getWorkScheduleById(old.id))?.gracePeriodMins).toBe(15);
 await work.recordAttendancePunch({staffId,punchType:'check_in',punchTime:'2026-08-01T08:30:00+03:00'},admin);
 expect((await work.recordAttendancePunch({staffId,punchType:'check_out',punchTime:'2026-08-01T16:00:00+03:00'},admin)).lateMinutes).toBe(0);
 expect((await work.createSchedule({...input,effectiveFrom:'2026-09-01',gracePeriodMins:0},admin)).gracePeriodMins).toBe(0);
});

it('split missing punches stay incomplete, late arrival of evidence repairs only the aggregate, and one-pair correction is refused',async()=>{
 await work.createSchedule({staffId,name:'Split evidence',scheduleType:'split',effectiveFrom:'2026-01-01',workingDays:[0,1,2,3,4,5,6],shiftStartTime:'08:00',shiftEndTime:'12:00',secondShiftStart:'16:00',secondShiftEnd:'20:00'},admin);
 const punch=(punchType:'check_in'|'check_out',time:string)=>work.recordAttendancePunch({staffId,punchType,punchTime:`2026-08-01T${time}:00+03:00`},admin);
 await punch('check_in','08:00');const missing=await punch('check_out','20:00');
 expect(missing.isIncomplete).toBe(true);expect(missing.workMinutes).toBe(0);
 await punch('check_in','16:00');const complete=await punch('check_out','12:00');
 expect(complete).toMatchObject({workMinutes:480,isIncomplete:false});
 expect(complete.checkOutRaw).toBe(missing.checkOutRaw);
 await expect(work.requestAttendanceCorrection({attendanceRecordId:complete.id,fieldCorrected:'check_out',newCheckOut:'2026-08-01T21:00:00+03:00',reason:'Cannot flatten two segments'},admin)).rejects.toThrow(/فترتين/);
 expect((await work.listAttendanceRecords({staffId}))[0]).toMatchObject({workMinutes:480,isIncomplete:false});
});
it('concurrent split events preserve all evidence and converge to the same result',async()=>{
 await work.createSchedule({staffId,name:'Concurrent split',scheduleType:'split',effectiveFrom:'2026-01-01',workingDays:[0,1,2,3,4,5,6],shiftStartTime:'08:00',shiftEndTime:'12:00',secondShiftStart:'16:00',secondShiftEnd:'20:00'},admin);
 // Reverse evidence arrives after the first entry; no external device is implied.
 await work.recordAttendancePunch({staffId,punchType:'check_in',punchTime:'2026-08-01T08:00:00+03:00'},admin);
 await Promise.all(([['check_out','20:00'],['check_out','12:00'],['check_in','16:00']] as const).map(([punchType,time])=>work.recordAttendancePunch({staffId,punchType,punchTime:`2026-08-01T${time}:00+03:00`},admin)));
 expect((await work.listAttendanceRecords({staffId}))[0]).toMatchObject({workMinutes:480,isIncomplete:false});
 expect((await db.getPool().query('SELECT * FROM hr_attendance_punch_events WHERE staff_id=$1',[staffId])).rows).toHaveLength(4);
});
it('policy patches preserve sibling values, reject null/unknown fields and roll back the entire multi-policy write',async()=>{
 await pay.updateHrSettings({attendancePolicy:{lateGraceMins:30} as any},admin);
 expect((await pay.getHrSettings()).attendancePolicy).toEqual({lateGraceMins:30,lateDeductionRatePerHour:1,overtimeRateMultiplier:1.5});
 const before=await pay.getHrSettings();
 for(const patch of [{attendancePolicy:{lateGraceMins:null}},{attendancePolicy:{unknown:2}},{unexpected:{}},{payrollCycle:{salaryDay:32}}]){
  await expect(pay.updateHrSettings(patch as any,admin)).rejects.toMatchObject({code:'invalid_setting'});
 }
 await expect(pay.updateHrSettings({attendancePolicy:{lateGraceMins:60} as any,leavePolicy:{annualDefaultDays:-1} as any},admin)).rejects.toMatchObject({code:'invalid_setting'});
 expect(await pay.getHrSettings()).toEqual(before);
 await expect(pay.updateHrSetting('unknown',{},admin)).rejects.toMatchObject({code:'invalid_setting'});
});
it('a new schedule does not reassign an existing attendance day on a new evidence upload',async()=>{
 const original=await work.createSchedule({staffId,name:'Original',scheduleType:'morning',effectiveFrom:'2026-01-01',workingDays:[0,1,2,3,4,5,6],shiftStartTime:'08:00',shiftEndTime:'16:00'},admin);
 await work.recordAttendancePunch({staffId,punchType:'check_in',punchTime:'2026-08-01T08:30:00+03:00'},admin);
 await work.createSchedule({staffId,name:'Different effective assignment',scheduleType:'morning',effectiveFrom:'2026-07-01',workingDays:[0,1,2,3,4,5,6],shiftStartTime:'09:00',shiftEndTime:'17:00'},admin);
 const completed=await work.recordAttendancePunch({staffId,punchType:'check_out',punchTime:'2026-08-01T16:00:00+03:00'},admin);
 expect(completed).toMatchObject({scheduleId:original.id,lateMinutes:30,earlyExitMinutes:0});
});
it('invalid legacy policy can be repaired only with a complete valid replacement',async()=>{
 await db.getPool().query("UPDATE hr_settings SET value='{\"lateGraceMins\":-500}'::jsonb WHERE key='attendance_policy'");
 await expect(pay.updateHrSettings({attendancePolicy:{lateGraceMins:30} as any},admin)).rejects.toMatchObject({code:'invalid_setting'});
 const fixed=await pay.updateHrSettings({attendancePolicy:{lateGraceMins:30,lateDeductionRatePerHour:0,overtimeRateMultiplier:1}},admin);
 expect(fixed.attendancePolicy?.lateGraceMins).toBe(30);
});
it('split second-period early entry is actual work and does not make the two pairs ambiguous',async()=>{
 await work.createSchedule({staffId,name:'Split early return',scheduleType:'split',effectiveFrom:'2026-01-01',workingDays:[0,1,2,3,4,5,6],shiftStartTime:'08:00',shiftEndTime:'12:00',secondShiftStart:'16:00',secondShiftEnd:'20:00'},admin);
 let record:any;
 for(const [punchType,time] of [['check_in','08:00'],['check_out','12:00'],['check_in','15:55'],['check_out','20:00']] as const)record=await work.recordAttendancePunch({staffId,punchType,punchTime:`2026-08-01T${time}:00+03:00`},admin);
 expect(record).toMatchObject({workMinutes:485,lateMinutes:0,earlyExitMinutes:0,isIncomplete:false});
});

it.each(['chronological','reverse','concurrent'] as const)('touching split shifts keep both boundary events with %s arrival and replay',async order=>{
 await work.createSchedule({staffId,name:'Touching split',scheduleType:'split',effectiveFrom:'2026-01-01',workingDays:[0,1,2,3,4,5,6],shiftStartTime:'08:00',shiftEndTime:'16:00',secondShiftStart:'16:00',secondShiftEnd:'20:00'},admin);
 const events=[['check_in','08:00'],['check_out','16:00'],['check_in','16:00'],['check_out','20:00']] as const;
 const punch=([punchType,time]:typeof events[number])=>work.recordAttendancePunch({staffId,punchType,punchTime:`2026-08-01T${time}:00+03:00`},admin);
 if(order==='concurrent'){await punch(events[0]);await Promise.all(events.slice(1).map(punch));}
 else for(const event of order==='reverse'?[...events].reverse():events)await punch(event);
 const complete=(await work.listAttendanceRecords({staffId}))[0];
 expect(complete).toMatchObject({workMinutes:720,lateMinutes:0,earlyExitMinutes:0,isIncomplete:false,status:'present'});
 for(const event of [events[1],events[2]])expect(await punch(event)).toMatchObject({workMinutes:720,isIncomplete:false});
 expect((await db.getPool().query('SELECT * FROM hr_attendance_punch_events WHERE staff_id=$1',[staffId])).rows).toHaveLength(6);
 await expect(work.requestAttendanceCorrection({attendanceRecordId:complete.id,fieldCorrected:'check_out',newCheckOut:'2026-08-01T21:00:00+03:00',reason:'Preserve segment correction protection'},admin)).rejects.toThrow(/فترتين/);
});

it.each(['check_in','check_out'] as const)('touching split shifts never invent a missing boundary %s',async missingType=>{
 await work.createSchedule({staffId,name:'Missing touching boundary',scheduleType:'split',effectiveFrom:'2026-01-01',workingDays:[0,1,2,3,4,5,6],shiftStartTime:'08:00',shiftEndTime:'16:00',secondShiftStart:'16:00',secondShiftEnd:'20:00'},admin);
 const punch=(punchType:'check_in'|'check_out',time:string)=>work.recordAttendancePunch({staffId,punchType,punchTime:`2026-08-01T${time}:00+03:00`},admin);
 await punch('check_in','08:00');await punch(missingType==='check_in'?'check_out':'check_in','16:00');
 const incomplete=await punch('check_out','20:00');
 expect(incomplete.isIncomplete).toBe(true);expect(incomplete.workMinutes).toBeLessThan(720);
 expect((await db.getPool().query('SELECT * FROM hr_attendance_punch_events WHERE staff_id=$1',[staffId])).rows).toHaveLength(3);
 expect(await punch(missingType,'16:00')).toMatchObject({workMinutes:720,isIncomplete:false});
});

it.each(['rejected','approved'] as const)('a legacy %s split correction uses decision status when later raw evidence arrives',async decision=>{
 await work.createSchedule({staffId,name:'Legacy correction split',scheduleType:'split',effectiveFrom:'2026-01-01',workingDays:[0,1,2,3,4,5,6],shiftStartTime:'08:00',shiftEndTime:'12:00',secondShiftStart:'16:00',secondShiftEnd:'20:00'},admin);
 const punch=(punchType:'check_in'|'check_out',time:string)=>work.recordAttendancePunch({staffId,punchType,punchTime:`2026-08-01T${time}:00+03:00`},admin);
 await punch('check_in','08:00');const first=await punch('check_out','12:00');
 // Before P1, split days could receive a single-pair request; retain that historical fixture.
 const {rows:[correction]}=await db.getPool().query(`INSERT INTO hr_attendance_corrections
  (attendance_id,staff_id,field_corrected,old_check_in,old_check_out,old_status,new_check_out,reason,requested_by,status)
  VALUES($1,$2,'check_out',$3,$4,$5,'2026-08-01T12:10:00+03:00','Historical split request',$6,'pending') RETURNING id`,[first.id,staffId,first.checkInActual,first.checkOutActual,first.status,admin.username]);
 if(decision==='rejected'){
  await work.decideAttendanceCorrection(correction.id,'rejected','Not approved',reviewer);
 }else{
  // A previously applied approval must stay intact; the current form refuses new split approvals.
  await db.getPool().query("UPDATE hr_attendance_corrections SET status='approved',approved_by=$2,approved_at=NOW() WHERE id=$1",[correction.id,reviewer.username]);
  await db.getPool().query("UPDATE hr_attendance_records SET check_out_actual='2026-08-01T12:10:00+03:00',work_minutes=250 WHERE id=$1",[first.id]);
 }
 const decided=(await db.getPool().query('SELECT * FROM hr_attendance_corrections WHERE id=$1',[correction.id])).rows[0];
 expect(decided.status).toBe(decision);expect(decided.approved_at).not.toBeNull();
 const before=(await work.listAttendanceRecords({staffId}))[0];
 await punch('check_in','16:00');const after=await punch('check_out','20:00');
 if(decision==='rejected')expect(after).toMatchObject({workMinutes:480,isIncomplete:false});
 else expect(after).toMatchObject({workMinutes:before.workMinutes,checkInActual:before.checkInActual,checkOutActual:before.checkOutActual,isIncomplete:before.isIncomplete});
 expect((await db.getPool().query('SELECT * FROM hr_attendance_punch_events WHERE staff_id=$1',[staffId])).rows).toHaveLength(4);
 expect((await db.getPool().query('SELECT * FROM hr_attendance_corrections WHERE id=$1',[correction.id])).rows[0]).toEqual(decided);
});

it('policy grace accepts the schema limit 120 and refuses 121 without persisting an unusable default',async()=>{
 await pay.updateHrSettings({attendancePolicy:{lateGraceMins:120} as any},admin);
 const before=await pay.getHrSettings();
 await expect(pay.updateHrSettings({attendancePolicy:{lateGraceMins:121} as any},admin)).rejects.toMatchObject({code:'invalid_setting',status:400});
 expect(await pay.getHrSettings()).toEqual(before);
 expect((await work.createSchedule({staffId,name:'Schema grace boundary',scheduleType:'morning',effectiveFrom:'2026-01-01',workingDays:[0,1,2,3,4,5,6],shiftStartTime:'08:00',shiftEndTime:'16:00'},admin)).gracePeriodMins).toBe(120);
});
it('explicit schedule grace over the schema limit is rejected before the database constraint',async()=>{
 const input={staffId,name:'Explicit grace boundary',scheduleType:'morning' as const,effectiveFrom:'2026-01-01',workingDays:[0,1,2,3,4,5,6],shiftStartTime:'08:00',shiftEndTime:'16:00'};
 await expect(work.createSchedule({...input,gracePeriodMins:121},admin)).rejects.toThrow('سماح الحضور غير صالح');
 const valid=await work.createSchedule({...input,gracePeriodMins:120},admin);
 await expect(work.updateWorkSchedule(valid.id,{gracePeriodMins:121},admin)).rejects.toThrow('سماح الحضور غير صالح');
 expect((await work.getWorkScheduleById(valid.id))?.gracePeriodMins).toBe(120);
});
