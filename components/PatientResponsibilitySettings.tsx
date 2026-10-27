"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useSession } from "./SessionProvider";
import type { ResponsibilitySettings, ResponsibilitySuggestion } from "@/lib/patient-responsibility-settings";
const SUGGESTION_BASIS: Record<ResponsibilitySuggestion["basis"], string> = { plan_items: "طبيب بنود علاج هذه الحالة", primary_doctor: "الطبيب الأساسي للمريض" };
const SUGGESTION_REASON: Record<ResponsibilitySuggestion["basis"], string> = { plan_items: "تأكيد الطبيب المقترح من بنود علاج الحالة", primary_doctor: "تأكيد الطبيب الأساسي للمريض مسؤولًا عن الحالة" };
type Props = { patientId: number; kind: "clinical" | "ortho"; sourceId: number; onSaved?: () => void };
export default function PatientResponsibilitySettings(props: Props) {
 const session = useSession();
 if (session?.role !== "admin") return null;
 return <ResponsibilityForm key={`${props.patientId}:${props.kind}:${props.sourceId}:${session.username}`} {...props} />;
}
function ResponsibilityForm({ patientId, kind, sourceId, onSaved }: Props) {
 const uid = useId(); const live = useRef(true); const pending = useRef(false);
 const [open, setOpen] = useState(false); const [data, setData] = useState<ResponsibilitySettings | null>(null);
 const [doctor, setDoctor] = useState(""); const [reason, setReason] = useState("");
 const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
 useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
 const url = `/api/patients/${patientId}/responsibility`;
 async function load() {
  if (!live.current || pending.current) return; pending.current = true; setBusy(true); setMessage("");
  try {
   const response = await fetch(`${url}?kind=${kind}&sourceId=${sourceId}`, { cache: "no-store" });
   const body = await response.json(); if (!live.current) return;
   if (!response.ok) { setMessage(body.message ?? "تعذّر تحميل المسؤولية."); return; }
   if (body.patientId !== patientId || body.kind !== kind || body.sourceId !== sourceId) { setMessage("تغيّر مرجع الحالة. أعد فتح الإعدادات."); return; }
   setData(body);
   // A case without a responsible doctor opens on the server's suggestion; it is saved only when the admin confirms.
   const proposed = body.doctorId == null && body.suggestion ? body.suggestion as ResponsibilitySuggestion : null;
   setDoctor(body.doctorId != null ? String(body.doctorId) : proposed ? String(proposed.doctorId) : "");
   if (proposed && !reason.trim()) setReason(SUGGESTION_REASON[proposed.basis]);
  } catch { if (live.current) setMessage("تعذّر تحميل المسؤولية. أعد المحاولة."); }
  finally { pending.current = false; if (live.current) setBusy(false); }
 }
 async function save() {
  if (!live.current || !data || pending.current || !doctor || reason.trim().length < 3) return;
  pending.current = true; setBusy(true); setMessage("");
  try {
   const response = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, sourceId, expectedSourceFingerprint: data.sourceFingerprint, doctorId: Number(doctor), reason: reason.trim() }) });
   const body = await response.json(); if (!live.current) return;
   if (!response.ok) {
    if ([401, 403, 409].includes(response.status)) setData(null);
    setMessage(body.message ?? "تعذّر حفظ المسؤولية. حدّث البيانات قبل المحاولة."); return;
   }
   setData(body); setReason(""); setMessage("حُفظ الطبيب المسؤول للمواعيد القادمة؛ لم تتغيّر المواعيد أو السجلات السابقة."); onSaved?.();
  } catch { if (live.current) setMessage("تعذّر التحقق من الحفظ. حدّث البيانات قبل إعادة المحاولة."); }
  finally { pending.current = false; if (live.current) setBusy(false); }
 }
 return <div dir="rtl" className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-2">
  <button type="button" aria-expanded={open} className="min-h-11 rounded-lg px-3 text-xs font-bold text-navy-900" onClick={() => { setOpen(!open); if (!open && !data) void load(); }}>إعداد الطبيب المسؤول</button>
  {open ? <div className="space-y-2 text-xs">
   <p className="text-slate-600">للإدارة فقط. يحدّد مسؤول الحالة الحالي للحجوزات القادمة، ولا يغيّر الطبيب المالي أو العلاج أو المواعيد السابقة.</p>
   {data ? <p>المسؤول الحالي: <strong>{data.doctorName ?? "غير محدّد"}</strong></p> : null}
   {data && data.doctorId === null && data.suggestion ? <p role="note" className="rounded-lg bg-sky-50 p-2 text-sky-900">مقترح: <strong>{data.suggestion.doctorName}</strong> — {SUGGESTION_BASIS[data.suggestion.basis]}. لا يُعتمد إلا بعد تأكيدك.</p> : null}
   {data && data.doctorId === null && data.suggestionNote ? <p role="note" className="text-amber-900">{data.suggestionNote}</p> : null}
   <label className="block" htmlFor={`${uid}-doctor`}>الطبيب المسؤول الجديد</label>
   <select id={`${uid}-doctor`} className="min-h-11 w-full rounded-lg border border-slate-300 bg-white px-2" value={doctor} disabled={busy || !data} onChange={event => setDoctor(event.target.value)}>
    <option value="">اختر طبيبًا نشطًا</option>{data?.doctors.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
   </select>
   <label className="block" htmlFor={`${uid}-reason`}>سبب تحديد أو تغيير المسؤولية</label>
   <textarea id={`${uid}-reason`} className="min-h-20 w-full rounded-lg border border-slate-300 p-2" maxLength={500} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} />
   <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || !data || !doctor || reason.trim().length < 3} className="min-h-11 rounded-lg bg-navy-900 px-3 font-bold text-white disabled:opacity-50" onClick={() => void save()}>{data && data.doctorId === null && data.suggestion && doctor === String(data.suggestion.doctorId) ? "تأكيد الطبيب المقترح" : "حفظ المسؤولية"}</button>
    <button type="button" disabled={busy} className="min-h-11 rounded-lg border border-slate-300 px-3" onClick={() => void load()}>تحديث البيانات</button></div>
   {busy ? <p role="status">جارٍ التحقق…</p> : null}{message ? <p role="status" className="text-slate-700">{message}</p> : null}
  </div> : null}
 </div>;
}
