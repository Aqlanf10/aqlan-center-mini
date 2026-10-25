"use client";
import { useState } from "react";
import { decodeLeadershipPulse } from "@/lib/leadership-pulse";
import { HR_ATTENDANCE_STATUS_LABEL, type HrAttendanceRecordView } from "@/lib/hr-contracts-attendance-shared";
import { hrHref } from "@/lib/hr-navigation";
import { LeadershipTasks, SourceState, leadershipTime } from "./LeadershipOverview";
import { useLeadershipRead } from "./useLeadershipRead";
import styles from "./leadership.module.css";

function AttendanceRows({ day, timeZone }: { day: string; timeZone: string }) {
 const read = useLeadershipRead(`/api/hr/attendance?startDate=${day}&endDate=${day}`, value => {
  if (!Array.isArray(value) || !value.every(row => row && Number.isSafeInteger(row.id) && row.id > 0 && Number.isSafeInteger(row.staffId) && row.staffId > 0
   && typeof row.staffName === "string" && row.attendanceDate === day && Object.hasOwn(HR_ATTENDANCE_STATUS_LABEL, row.status)
   && (row.checkInActual === null || typeof row.checkInActual === "string" && Number.isFinite(Date.parse(row.checkInActual))))) return null;
  return value as HrAttendanceRecordView[];
 });
 return <><SourceState {...read} onRetry={read.refresh} />{read.data && <>
  <p className={styles.sourceLine}>{read.data.length} سجل حضور في {day} · استُلمت القراءة {read.receivedAt ? leadershipTime(read.receivedAt, timeZone) : ""}</p>
  <ul className={styles.evidenceList}>{read.data.slice(0, 10).map(row => <li key={row.id} className={styles.evidenceRow}><div className={styles.rowTitle}>
   <a className={styles.patientLink} href={hrHref("", { tab: "staff", staffId: String(row.staffId), profileTab: "attendance" })}>{row.staffName}</a><span className={styles.status}>{HR_ATTENDANCE_STATUS_LABEL[row.status]}</span></div>
   <p>الدخول الفعلي المسجّل: {row.checkInActual ? leadershipTime(row.checkInActual, timeZone) : "غير مسجل"}</p></li>)}</ul>
  {read.data.length === 0 && <p className={styles.empty}>لا سجلات حضور لهذا اليوم. هذا لا يثبت غياب الطاقم.</p>}
  {read.data.length > 10 && <p className={styles.sourceLine}>أول 10 سجلات؛ افتح الحضور لعرض البقية.</p>}
 </>}</>;
}
function Attendance() {
 const [day, setDay] = useState("");
 const context = useLeadershipRead("/api/executive/pulse?view=day", value => decodeLeadershipPulse(value, "day", null));
 return <section className={styles.panel} data-testid="leadership-attendance"><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>سجلات الحضور، لا حضور مباشر</p><h2>الحضور المسجّل للفريق</h2></div><a className={styles.textLink} href="/hr?tab=attendance">فتح الحضور</a></div>
  <SourceState {...context} onRetry={context.refresh} />{context.data && <><label className={styles.dayLabel}>يوم الحضور<input type="date" value={day || context.data.day} onChange={e => setDay(e.target.value)} /></label>
  <AttendanceRows key={day || context.data.day} day={day || context.data.day} timeZone={context.data.timeZone} /></>}
  <p className={styles.footnote}>لا نسبة حضور بلا قائمة دوام متوقعة موثّقة. حجز الطبيب أو تسجيل دخوله لا يثبت تفرغه لموعد جديد.</p>
 </section>;
}
function InventoryAlerts() {
 const read = useLeadershipRead("/api/inventory", value => {
  const alerts = (value as {alerts?: Record<string, unknown[]>} | null)?.alerts;
  if (!alerts || ![alerts.lowItems, alerts.expired, alerts.soon].every(Array.isArray)
   || !alerts.lowItems.every(row => !!row && typeof (row as {name?:unknown}).name === "string")
   || ![...alerts.expired,...alerts.soon].every(row => !!row && typeof (row as {itemName?:unknown}).itemName === "string")) return null;
  return {low: alerts.lowItems.length, expired: alerts.expired.length, soon: alerts.soon.length};
 });
 return <section className={styles.panel} data-testid="leadership-inventory"><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>المصدر التشغيلي الحالي</p><h2>تنبيهات المخزون</h2></div><a className={styles.textLink} href="/inventory">فتح المخزون</a></div>
  <SourceState {...read} onRetry={read.refresh} />{read.data && <div className={styles.factStrip}><p><strong>{read.data.low}</strong> صنف عند حد الطلب</p><p><strong>{read.data.expired}</strong> دفعة منتهية</p><p><strong>{read.data.soon}</strong> دفعة تقارب الانتهاء</p></div>}
  <p className={styles.footnote}>الأصناف والدفعات وحدات مختلفة، فلا نجمعها في عدد أصناف واحد. لا تنفذ هذه القراءة شراءً أو تغييرًا للمخزون.</p>
 </section>;
}
export function LeadershipTeam() {
 const [attendance, setAttendance] = useState(false), [inventory, setInventory] = useState(false);
 return <div className={styles.stack}><LeadershipTasks />
  <nav className={styles.moduleLinks} aria-label="مصادر الفريق"><a href="/hr?tab=staff">ملفات الطاقم</a><a href="/hr?tab=leaves">الإجازات</a><a href="/appointments">أوقات الأطباء وقواعد الحجز</a><a href="/settings/audit">سجل الإجراءات</a></nav>
  <button type="button" className={styles.disclosure} aria-expanded={attendance} onClick={() => setAttendance(v => !v)}>الحضور المسجّل <span>{attendance ? "إخفاء" : "عرض القراءة"}</span></button>{attendance && <Attendance />}
  <button type="button" className={styles.disclosure} aria-expanded={inventory} onClick={() => setInventory(v => !v)}>تنبيهات المخزون <span>{inventory ? "إخفاء" : "عرض القراءة"}</span></button>{inventory && <InventoryAlerts />}
 </div>;
}
