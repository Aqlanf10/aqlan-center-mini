"use client";
import { useEffect, useRef, useState } from "react";
import { readPatientNumberSnapshot } from "@/lib/patient-numbering-read-model";
import { useSession } from "@/components/SessionProvider";
import { isAdmin } from "@/lib/roles";
import { parsePatientNumber, numberingReason, type PatientNumberSnapshot } from "@/lib/patient-numbering";

/** Dedicated edit command: never piggyback numbering on the demographic PATCH. */
export function PatientNumberEditor({patientId, onChanged}: {patientId: number; onChanged: () => void}) {
  const session = useSession();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<PatientNumberSnapshot | null>(null);
  const [number, setNumber] = useState(""), [reason, setReason] = useState(""), [confirm, setConfirm] = useState("");
  const [error, setError] = useState(""), [success, setSuccess] = useState("");
  const generation = useRef(0), saving = useRef(false);
  useEffect(() => { generation.current++; setOpen(false); setSnapshot(null); setError(""); setSuccess(""); saving.current=false; setBusy(false); }, [patientId]);
  useEffect(() => () => { generation.current++; }, []);
  async function load() {
    if (saving.current) return;
    const token = ++generation.current;
    setBusy(true); setError(""); setSuccess(""); setSnapshot(null); setOpen(true);
    try {
      const response = await fetch(`/api/patients/${patientId}/number`, {cache: "no-store"});
      const data = await response.json();
      if (token !== generation.current) return;
      if (!response.ok) throw new Error(data.message || "تعذّر تحميل الرقم الحالي.");
      const accepted = readPatientNumberSnapshot(data, patientId);
      if (!accepted) throw new Error("تعذّر التحقق من رقم هذا الملف؛ أعد التحميل.");
      setSnapshot(accepted); setNumber(""); setReason(""); setConfirm("");
    } catch (cause) { if (token === generation.current) setError(cause instanceof Error ? cause.message : "تعذّر تحميل الرقم الحالي."); }
    finally { if (token === generation.current) setBusy(false); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving.current || !snapshot) return;
    const newNumber = parsePatientNumber(number);
    if (!newNumber || !numberingReason(reason) || confirm !== snapshot.patientNumber) { setError("أدخل رقمًا صحيحًا وسببًا، واكتب رقم الملف الحالي للتأكيد."); return; }
    const token = generation.current;
    saving.current=true; setBusy(true); setError("");
    try {
      const response = await fetch(`/api/patients/${patientId}/number`, {method: "PATCH", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({patientNumber: newNumber, expectedVersion: snapshot.version, expectedPatientNumber: snapshot.patientNumber, reason})});
      const data = await response.json();
      if (token !== generation.current) return;
      if (!response.ok) { if (data.code === "stale") setSnapshot(null); throw new Error(data.message || "تعذّر تعديل الرقم."); }
      const accepted = readPatientNumberSnapshot(data, patientId);
      if (!accepted || accepted.patientNumber !== newNumber || BigInt(accepted.version) !== BigInt(snapshot.version) + 1n) { setSnapshot(null); throw new Error("لم يتأكد الحفظ لهذا الملف؛ حدّث الرقم قبل إعادة المحاولة."); }
      setOpen(false); setSnapshot(null); setSuccess(`حُفظ رقم الملف ${accepted.patientNumber} وسُجّل التغيير. أبلغ المريض برقم الدخول الجديد.`); onChanged();
    } catch (cause) { if (token === generation.current) { setError(cause instanceof Error ? cause.message : "لم يتأكد الحفظ؛ حدّث الرقم قبل إعادة المحاولة."); } }
    finally { if (token === generation.current) {saving.current=false; setBusy(false);} }
  }
  if (!session || !isAdmin(session.role)) return null;
  return <section className="space-y-3" aria-label="تعديل رقم ملف المريض">
    {!open && <button type="button" className="btn btn-secondary min-h-11" onClick={load}>تعديل رقم الملف</button>}
    {success && <p role="status" className="text-emerald-700">{success}</p>}
    {open && <form onSubmit={save} className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
      <h3 className="font-semibold">تعديل رقم الملف فقط</h3>
      <p className="text-sm">يبقى المريض وسجله الطبي والمالي كما هما. الرقم القديم لن يُعاد استخدامه. المستندات السابقة تبقى مرجعًا تاريخيًا، ودخول بوابة المريض سيكون بالرقم الجديد.</p>
      {busy && !snapshot && <p role="status">جارٍ تحميل الرقم الحالي…</p>}
      {snapshot && <>
        <p>رقم الملف الحالي: <b dir="ltr">{snapshot.patientNumber}</b></p>
        <label className="block">رقم الملف الجديد<input className="input mt-1 block w-full" dir="ltr" inputMode="numeric" value={number} onChange={e=>setNumber(e.target.value)} maxLength={21} disabled={busy} required /></label>
        {parsePatientNumber(number) && <p className="text-sm">سيُحفظ بالشكل: <b dir="ltr">{parsePatientNumber(number)}</b></p>}
        <label className="block">سبب التعديل<textarea className="input mt-1 block w-full" value={reason} onChange={e=>setReason(e.target.value)} minLength={3} maxLength={300} disabled={busy} required /></label>
        <label className="block">اكتب الرقم الحالي للتأكيد<input className="input mt-1 block w-full" dir="ltr" value={confirm} onChange={e=>setConfirm(e.target.value)} disabled={busy} autoComplete="off" required /></label>
        <button className="btn btn-primary min-h-11" disabled={busy || !parsePatientNumber(number) || !numberingReason(reason) || confirm !== snapshot.patientNumber}>{busy ? "جارٍ الحفظ…" : "حفظ رقم الملف الجديد"}</button>
      </>}
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <div className="flex gap-3"><button type="button" className="btn btn-secondary min-h-11" disabled={busy} onClick={load}>تحديث الرقم الحالي</button>
        <button type="button" className="btn btn-secondary min-h-11" disabled={saving.current} onClick={()=>{if(saving.current)return;generation.current++;setOpen(false);setBusy(false);setSnapshot(null);setError("");}}>إلغاء</button></div>
    </form>}
  </section>;
}
