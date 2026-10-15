import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>, db: typeof import("../../lib/db"), payroll: typeof import("../../lib/hr-payroll");
const saved = { url: process.env.DATABASE_URL, seed: process.env.SKIP_SEED };
beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  process.env.DATABASE_URL = fixture.source.options.connectionString!; process.env.SKIP_SEED = "false";
  db = await import("../../lib/db"); payroll = await import("../../lib/hr-payroll");
  await db.ensureSchema();
  const staff = (await fixture.source.query("INSERT INTO hr_staff(full_name,created_by) VALUES('Synthetic daily report','synthetic') RETURNING id")).rows[0].id;
  for (const date of ["2026-12-31", "2027-01-01", "2027-01-02"]) {
    await fixture.source.query("INSERT INTO hr_attendance_records(staff_id,attendance_date,status,is_incomplete,overtime_minutes,created_by) VALUES($1,$2,'late',TRUE,120,'synthetic')", [staff, date]);
  }
  await fixture.source.query("INSERT INTO hr_contracts(staff_id,contract_number,template_kind,title,status,start_date,end_date,compensation_kind,created_by) VALUES($1,'TEST-REPORT-1','support_staff','Synthetic expiry','approved','2026-01-01','2027-01-01','commission','synthetic')", [staff]);
});
afterAll(async () => {
  vi.useRealTimers();
  try { await db?.resetPoolForTesting(); await fixture?.close(); }
  finally { process.env.DATABASE_URL = saved.url; process.env.SKIP_SEED = saved.seed; }
});
it("today means the clinic day across UTC midnight and year rollover, excluding yesterday and tomorrow", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // UTC is still December; Asia/Aden has entered January 1.
    vi.setSystemTime(new Date("2026-12-31T22:30:00Z"));
    const report = await payroll.getHrReportSummary();
    expect(report.attendanceExceptions).toEqual({ date: "2027-01-01", latePunchesCount: 1, incompletePunchesCount: 1, totalOvertimeHours: 2 });
    expect(report.expiringContracts).toHaveLength(1);
    expect(report.expiringContracts[0]).toMatchObject({ endDate: "2027-01-01", daysRemaining: 0 });
    vi.setSystemTime(new Date("2027-01-01T21:01:00Z"));
    const next = await payroll.getHrReportSummary();
    expect(next.attendanceExceptions.date).toBe("2027-01-02");
    expect(next.attendanceExceptions.latePunchesCount).toBe(1);
    expect(next.expiringContracts).toEqual([]);
  } finally { vi.useRealTimers(); }
});
