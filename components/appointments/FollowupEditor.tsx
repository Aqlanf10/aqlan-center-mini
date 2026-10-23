"use client";
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { parseFollowupCommand, type FollowupCommand, type FollowupOutcome } from "@/lib/appointment-followup-contract";
import type { readAppointmentFollowupEditor } from "@/lib/appointment-followup-db";
type Editor = Awaited<ReturnType<typeof readAppointmentFollowupEditor>>;
let sequence = 0;
const sessions = new WeakMap<object, number>();
const button = "min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold disabled:opacity-50";
/** Remount on session object replacement, including A → B → A; old replies cannot render. */
export function FollowupEditor(props: { appointmentId: number; patientId: number }) {
  const session = useSession();
  if (!session || !["admin", "reception"].includes(session.role)) return null;
  if (!sessions.has(session)) sessions.set(session, ++sequence);
  return <EditorForm key={`${sessions.get(session)}:${props.patientId}:${props.appointmentId}`} {...props} />;
}
function EditorForm({ appointmentId, patientId }: { appointmentId: number; patientId: number }) {
  const [data, setData] = useState<Editor | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<FollowupCommand | null>(null);
  const [rejected, setRejected] = useState(false);
  const [outcome, setOutcome] = useState<FollowupOutcome>("no_answer");
  const [assignee, setAssignee] = useState(0);
  const [hours, setHours] = useState("24");
  const [reload, setReload] = useState(0);
  const active = useRef(false);
  const pending = useRef(false);
  const storageKey = data ? `appointment-followup:v1:${data.actorUserId}:${patientId}:${appointmentId}` : null;
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    setData(null);
    void (async () => {
      try {
        const response = await fetch(`/api/appointments/${appointmentId}/followup?patientId=${patientId}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (!active.current || controller.signal.aborted) return;
        if (!response.ok) throw new Error(body.message ?? "تعذّر تحميل سياق المتابعة.");
        const context = body as Editor;
        if (context.source?.appointmentId !== appointmentId || context.source.expectedPatientId !== patientId || !Number.isInteger(context.actorUserId)) throw new Error("تعذّر التحقق من سياق المتابعة.");
        const saved = localStorage.getItem(`appointment-followup:v1:${context.actorUserId}:${patientId}:${appointmentId}`);
        const command = saved ? parseFollowupCommand(JSON.parse(saved)) : null;
        if (saved && (!command || command.appointmentId !== appointmentId || command.expectedPatientId !== patientId)) throw new Error("طلب محفوظ غير صالح. يلزم مراجعته قبل أي إجراء جديد.");
        setAttempt(command); setAssignee(context.assigneeUserId); setData(context);
      } catch (error) { if (active.current && !controller.signal.aborted) setMessage(error instanceof Error ? error.message : "تعذّر تحميل المتابعة."); }
    })();
    return () => { active.current = false; controller.abort(); };
  }, [appointmentId, patientId, reload]);
  async function save() {
    if (!data || !storageKey || pending.current || (!attempt && (data.blocked || data.closed))) return;
    const closed = outcome === "resolved" || outcome === "declined";
    const command = attempt ?? parseFollowupCommand({ ...data.source, requestId: crypto.randomUUID(), expectedRevision: data.revision,
      assigneeUserId: assignee, dueAt: new Date(Date.now() + Number(hours) * 3600000).toISOString(),
      status: data.revision === 0 ? "open" : closed ? "closed" : "open",
      outcome: data.revision === 0 ? "pending" : outcome,
      nextStep: data.revision !== 0 && closed ? "none" : outcome === "rebooking_review" ? "review" : "call" });
    if (!command) { setMessage("راجع بيانات المتابعة."); return; }
    pending.current = true; setBusy(true); setRejected(false);
    try {
      // Persist BEFORE sending. Storage failure prevents a non-recoverable mutation.
      localStorage.setItem(storageKey, JSON.stringify(command)); setAttempt(command);
      const response = await fetch(`/api/appointments/${appointmentId}/followup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
      const result = await response.json();
      if (!active.current) return;
      if (!response.ok) {
        setRejected([400, 404, 409].includes(response.status));
        throw new Error(result.message ?? "تعذّر تأكيد الحفظ. أعد الطلب نفسه.");
      }
      if (!Number.isInteger(result.followupId) || result.revision !== command.expectedRevision + 1) throw new Error("نتيجة الحفظ غير مؤكدة. أعد الطلب نفسه.");
      localStorage.removeItem(storageKey); setAttempt(null);
      setMessage("حُفظت المتابعة. لا يُعدّ هذا إثبات إرسال رسالة أو تسليمها."); setReload(value => value + 1);
      window.dispatchEvent(new Event("appointment-followup-changed"));
    } catch (error) { if (active.current) setMessage(error instanceof Error ? error.message : "النتيجة غير مؤكدة. أعد الطلب نفسه دون تعديل."); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <section dir="rtl" aria-label="إجراء متابعة الغياب" className="mt-3 space-y-3 rounded-xl border border-sky-200 bg-sky-50/40 p-4">
    <h3 className="font-bold">متابعة الغياب</h3>
    {message ? <p role="status" className="text-sm text-slate-700">{message}</p> : null}
    {!data ? <button className={button} onClick={() => setReload(v => v + 1)}>تحميل سياق المتابعة</button> : <>
      {data.blocked || data.closed ? <p className="text-sm">{data.closed ? "المتابعة مغلقة." : "الموعد يحتاج مراجعة؛ إجراءات المتابعة محجوبة لحماية ارتباط المريض."}</p> : null}
      {attempt ? <p className="text-sm font-bold">طلب محفوظ: أعد المحاولة نفسها للتحقق من نتيجته، حتى بعد إعادة فتح الصفحة.</p> : null}
      <fieldset disabled={busy || !!attempt || data.blocked || data.closed} className="flex flex-wrap gap-3 disabled:opacity-60">
        <label className="text-sm">المسؤول<select className="mt-1 block min-h-11 max-w-full rounded-lg border bg-white p-2" value={assignee} onChange={e => setAssignee(Number(e.target.value))}>{data.assignees.map(user => <option key={user.id} value={user.id}>{user.display_name}</option>)}</select></label>
        {data.revision > 0 ? <label className="text-sm">نتيجة المتابعة<select className="mt-1 block min-h-11 rounded-lg border bg-white p-2" value={outcome} onChange={e => setOutcome(e.target.value as FollowupOutcome)}>
          <option value="no_answer">لم يرد — تبقى مفتوحة</option><option value="awaiting_reply">بانتظار الرد — تبقى مفتوحة</option><option value="rebooking_review">مراجعة إعادة الحجز</option><option value="declined">رفض المتابعة — إغلاق</option><option value="resolved">انتهت المتابعة — إغلاق</option>
        </select></label> : <p className="self-center text-sm">فتح مهمة لا يسجّل اتصالاً أو رسالة.</p>}
        <label className="text-sm">المراجعة التالية بعد<select className="mt-1 block min-h-11 rounded-lg border bg-white p-2" value={hours} onChange={e => setHours(e.target.value)}><option value="1">ساعة</option><option value="24">يوم</option><option value="48">يومين</option><option value="168">أسبوع</option></select></label>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button className={`${button} bg-navy-900 text-white`} disabled={busy || (!attempt && (data.blocked || data.closed))} onClick={() => void save()}>{busy ? "جارٍ التحقق…" : attempt ? "إعادة المحاولة نفسها" : data.revision === 0 ? "فتح متابعة" : "حفظ نتيجة المتابعة"}</button>
        {rejected && !busy ? <button className={button} onClick={() => { if (storageKey) localStorage.removeItem(storageKey); setAttempt(null); setRejected(false); setReload(v => v + 1); }}>تحديث السياق بعد الرفض</button> : null}
        {!data.blocked ? <a className={button} href={`/patients/${patientId}?tab=summary`}>ملف المريض وإعادة حجز الجلسة</a> : null}
      </div>
      <p className="text-xs text-slate-600">إعادة حجز الجلسة تتم من ملخص المريض عبر الحجز المعتمد، وتبقي الموعد السابق محفوظاً. هذه المتابعة لا تنشئ موعداً ولا تغيّر الحضور.</p>
    </>}
  </section>;
}
