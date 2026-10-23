"use client";
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { parseFollowupCommand, followupFingerprintInput, type FollowupCommand, type FollowupOutcome } from "@/lib/appointment-followup-contract";
import { FOLLOWUP_ATTEMPT_CHANGED, followupAttemptKey, readFollowupAttempt, removeOwnedFollowupAttempt, withFollowupAttemptLock, notifyFollowupAttemptChanged } from "@/lib/appointment-followup-attempt";
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
  const [outcome, setOutcome] = useState<FollowupOutcome>("no_answer");
  const [assignee, setAssignee] = useState(0);
  const [hours, setHours] = useState("24");
  const [reload, setReload] = useState(0);
  const active = useRef(false);
  const pending = useRef(false);
  const storageKey = data ? followupAttemptKey(data.actorUserId, patientId, appointmentId) : null;
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
        const saved = readFollowupAttempt(localStorage, followupAttemptKey(context.actorUserId, patientId, appointmentId), patientId, appointmentId, context.actorUserId);
        setAttempt(saved?.command ?? null); setAssignee(context.assigneeUserId); setData(context);
      } catch (error) { if (active.current && !controller.signal.aborted) setMessage(error instanceof Error ? error.message : "تعذّر تحميل المتابعة."); }
    })();
    return () => { active.current = false; controller.abort(); };
  }, [appointmentId, patientId, reload]);
  // Advisory synchronization improves both editors' UI. The lock below is still
  // required if events are delayed, missed, or delivered after a stale click.
  useEffect(() => {
    if (!storageKey || !data) return;
    const sync = () => {
      if (!active.current || pending.current) return;
      try {
        const saved = readFollowupAttempt(localStorage, storageKey, patientId, appointmentId, data.actorUserId);
        setAttempt(saved?.command ?? null);
        if (!saved) setReload(value => value + 1);
      } catch (error) { setMessage(error instanceof Error ? error.message : "تعذّر قراءة الطلب المحفوظ."); }
    };
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === storageKey) sync(); };
    const storage = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) sync(); };
    window.addEventListener(FOLLOWUP_ATTEMPT_CHANGED, changed);
    window.addEventListener("storage", storage);
    return () => { window.removeEventListener(FOLLOWUP_ATTEMPT_CHANGED, changed); window.removeEventListener("storage", storage); };
  }, [storageKey, patientId, appointmentId, data]);
  async function save(retire = false) {
    if ((retire && !attempt) || !data || !storageKey || pending.current || (!attempt && (data.blocked || data.closed))) return;
    pending.current = true; setBusy(true);
    try {
      const acquired = await withFollowupAttemptLock(storageKey, async () => {
        if (!active.current) return;
        // Refresh authority even for a replay: a cookie/account may have changed
        // in another tab without replacing this tab's SessionProvider yet.
        const contextResponse = await fetch(`/api/appointments/${appointmentId}/followup?patientId=${patientId}`, { cache: "no-store" });
        const fresh = await contextResponse.json() as Editor & { message?: string };
        if (!active.current) return;
        if (!contextResponse.ok) {
          if (contextResponse.status === 401 || contextResponse.status === 403) { setAttempt(null); setData(null); }
          throw new Error(fresh.message ?? "تعذّر التحقق من سياق المتابعة.");
        }
        if (fresh.actorUserId !== data.actorUserId) {
          setAttempt(null); setData(null);
          setMessage("تغيّرت الجلسة. أعد تحميل الصفحة؛ بقي طلب المستخدم السابق محفوظاً دون إرسال أو حذف."); return;
        }
        const saved = readFollowupAttempt(localStorage, storageKey, patientId, appointmentId, data.actorUserId);
        if (saved && (!attempt || JSON.stringify(saved.command) !== JSON.stringify(attempt))) {
          setAttempt(saved.command);
          setMessage("هناك محاولة محفوظة لهذا الموعد. أعد المحاولة نفسها للتحقق؛ لم تُستبدل ببيانات هذا المحرر.");
          return;
        }
        if (!saved && attempt) {
          setAttempt(null); setReload(value => value + 1);
          setMessage("تغيّرت ملكية المحاولة في محرر آخر. حدّث السياق قبل إجراء جديد.");
          return;
        }
        if (retire && !saved) throw new Error("لا توجد محاولة محفوظة للتحقق منها.");
        let command = saved?.command;
        let raw = saved?.raw;
        if (!command) {
          // A stale editor may have missed another tab's acknowledged save and
          // removal. Re-read the server revision while holding the shared lock,
          // before persisting any new intent. Never auto-apply old form choices.
          if (fresh.revision !== data.revision
            || JSON.stringify(fresh.source) !== JSON.stringify(data.source) || fresh.blocked || fresh.closed) {
            setReload(value => value + 1); setMessage("تغيّر المستخدم أو سياق المتابعة. راجع البيانات المحدثة قبل إجراء جديد."); return;
          }
          const closed = outcome === "resolved" || outcome === "declined";
          command = parseFollowupCommand({ ...data.source, expectedActorUserId: data.actorUserId, requestId: crypto.randomUUID(), expectedRevision: data.revision,
            assigneeUserId: assignee, dueAt: new Date(Date.now() + Number(hours) * 3600000).toISOString(),
            status: data.revision === 0 ? "open" : closed ? "closed" : "open",
            outcome: data.revision === 0 ? "pending" : outcome,
            nextStep: data.revision !== 0 && closed ? "none" : outcome === "rebooking_review" ? "review" : "call" }) ?? undefined;
          if (!command) throw new Error("راجع بيانات المتابعة.");
          raw = JSON.stringify(command);
          // No other cooperating editor can write this slot until ack/unknown.
          // Also refuse a non-cooperating writer that changed it during the GET.
          if (localStorage.getItem(storageKey) !== null) throw new Error("ظهرت محاولة محفوظة في محرر آخر. حدّث السياق مع إبقاء الطلب.");
          localStorage.setItem(storageKey, raw); setAttempt(command);
          notifyFollowupAttemptChanged(storageKey);
        }
        const response = await fetch(`/api/appointments/${appointmentId}/followup${retire ? "/retire" : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
        const result = await response.json();
        if (!active.current) return; // Keep evidence after session/owner replacement.
        if (!response.ok) {
          if (response.status === 401 || response.status === 403 || result.code === "FOLLOWUP_ACTOR_CHANGED") {
            setAttempt(null); setData(null); // Hide old actor state, never erase durable evidence.
          }
          throw new Error((result.message ?? "تعذّر تأكيد الحفظ.") + " الطلب محفوظ؛ تحديث السياق لا يمحوه.");
        }
        if (retire) {
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(followupFingerprintInput(command)));
          const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
          if (!active.current) return;
          if (response.status !== 200 || result.requestId !== command.requestId || result.actorUserId !== command.expectedActorUserId
            || result.fingerprint !== fingerprint || !["retired", "committed"].includes(result.outcome)) throw new Error("إثبات نتيجة المحاولة غير مطابق؛ بقي الطلب محفوظاً.");
          if (result.outcome === "committed") {
            setMessage("هذه المحاولة حُفظت سابقاً. أعد المحاولة نفسها لاستلام تأكيدها؛ لم تُلغَ ولم تُحذف."); return;
          }
          if (!removeOwnedFollowupAttempt(localStorage, storageKey, raw!)) throw new Error("تأكد إلغاء المفتاح، لكن المحاولة المحفوظة تغيّرت؛ لم تُحذف.");
          setAttempt(null); notifyFollowupAttemptChanged(storageKey); setReload(value => value + 1);
          setMessage("تأكد أن المحاولة لم تُحفظ وأُغلق مفتاحها نهائياً. راجع البيانات ثم ابدأ محاولة جديدة بموعد صالح."); return;
        }
        if (!Number.isInteger(result.followupId) || result.followupId <= 0 || result.followupId > 2147483647
          || result.revision !== command.expectedRevision + 1 || typeof result.replayed !== "boolean"
          || ![200, 201].includes(response.status) || (response.status === 200) !== result.replayed) throw new Error("نتيجة الحفظ غير مؤكدة. أعد الطلب نفسه.");
        if (!removeOwnedFollowupAttempt(localStorage, storageKey, raw!)) throw new Error("تأكد الحفظ، لكن توجد محاولة أخرى محفوظة؛ لم تُحذف. حدّث السياق.");
        setAttempt(null); notifyFollowupAttemptChanged(storageKey);
        setMessage("حُفظت المتابعة. لا يُعدّ هذا إثبات إرسال رسالة أو تسليمها."); setReload(value => value + 1);
        window.dispatchEvent(new Event("appointment-followup-changed"));
      });
      if (!acquired && active.current) setMessage("يجري التحقق من محاولة هذا الموعد في محرر آخر. انتظر ثم أعد التحقق؛ لم يُرسل طلب جديد.");
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
        {attempt && !busy ? <button className={button} onClick={() => void save(true)}>إلغاء محاولة منتهية لم تُحفظ</button> : null}
        {attempt && !busy ? <button className={button} onClick={() => setReload(value => value + 1)}>تحديث السياق مع إبقاء الطلب</button> : null}
        {!data.blocked ? <a className={button} href={`/patients/${patientId}?tab=summary`}>ملف المريض وإعادة حجز الجلسة</a> : null}
      </div>
      <p className="text-xs text-slate-600">إعادة حجز الجلسة تتم من ملخص المريض عبر الحجز المعتمد، وتبقي الموعد السابق محفوظاً. هذه المتابعة لا تنشئ موعداً ولا تغيّر الحضور.</p>
    </>}
  </section>;
}
