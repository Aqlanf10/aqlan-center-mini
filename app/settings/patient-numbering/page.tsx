"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { readNumberingPreview } from "@/lib/patient-numbering-read-model";
import { useSession } from "@/components/SessionProvider";
import { isAdmin } from "@/lib/roles";
import { parseNumberingFloor, parsePatientNumber, numberingReason, type NumberingPreview } from "@/lib/patient-numbering";

export default function PatientNumberingPage() {
  const session = useSession();
  if (!session || !isAdmin(session.role)) return <p role="alert">لا توجد صلاحية لإعداد ترقيم الملفات.</p>;
  return <PatientNumberingWorkspace key={JSON.stringify([session.username, session.role, session.permissions ?? null])} />;
}

function PatientNumberingWorkspace() {
  const [preview, setPreview] = useState<NumberingPreview | null>(null), [floor, setFloor] = useState("");
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [success, setSuccess] = useState("");
  const generation = useRef(0), saving = useRef(false);
  const load = useCallback(async () => {
    if (saving.current) return;
    const token = ++generation.current; setBusy(true);setError("");setPreview(null);
    try {
      const response=await fetch("/api/settings/patient-numbering", {cache:"no-store"}); const data=await response.json();
      if (token !== generation.current) return;
      if (!response.ok) throw new Error(data.message || "تعذّر تحميل المعاينة.");
      const accepted=readNumberingPreview(data);
      if(!accepted)throw new Error("تعذّر التحقق من معاينة الترقيم؛ أعد التحميل.");
      setPreview(accepted); setFloor(accepted.minimumNext);
    } catch (cause) {if (token===generation.current) setError(cause instanceof Error ? cause.message : "تعذّر تحميل المعاينة.");}
    finally {if (token===generation.current) setBusy(false);}
  }, []);
  useEffect(()=>{const counter=generation; void load(); return ()=>{counter.current++;};},[load]);
  const parsedFloor=parseNumberingFloor(floor);
  const proposed = preview?.nextNumber && parsedFloor ? parsePatientNumber((BigInt(parsedFloor)>BigInt(preview.nextNumber.slice(2)) ? parsedFloor : preview.nextNumber.slice(2))) : null;
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (saving.current || !preview || !parsedFloor || !numberingReason(reason)) return;
    saving.current=true;setBusy(true);setError("");setSuccess("");const token=generation.current;
    try {
      const response=await fetch("/api/settings/patient-numbering",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({minimumNext:parsedFloor,expectedVersion:preview.version,expectedNextNumber:preview.nextNumber,reason})});
      const data=await response.json(); if(token!==generation.current)return;
      if(!response.ok){if(data.code==="stale")setPreview(null);throw new Error(data.message || "تعذّر حفظ الإعداد.");}
      const accepted=readNumberingPreview(data);
      if(!accepted || accepted.minimumNext !== parsedFloor || BigInt(accepted.version) !== BigInt(preview.version)+1n){setPreview(null);throw new Error("لم يتأكد حفظ الإعداد؛ حدّث المعاينة قبل إعادة المحاولة.");}
      setPreview(accepted);setFloor(accepted.minimumNext);setReason("");setSuccess("حُفظ الحد الأدنى للملفات الجديدة فقط؛ لم يتغيّر أي رقم قائم.");
    }catch(cause){if(token===generation.current)setError(cause instanceof Error ? cause.message : "لم يتأكد الحفظ؛ حدّث المعاينة قبل إعادة المحاولة.");}
    finally {if(token===generation.current){saving.current=false;setBusy(false);}}
  }
  return <main className="mx-auto max-w-3xl space-y-6 p-4" dir="rtl">
    <Link href="/settings" className="underline">العودة إلى الإعدادات</Link><h1 className="text-2xl font-bold">ترقيم ملفات المرضى الجدد</h1>
    <p>يبدأ الترقيم من <b dir="ltr">P-07000</b> أو أعلى رقم متاح بعد العداد والأرقام المستخدمة سابقًا. لا يعيد هذا الإعداد ترقيم المرضى السابقين، ولا يُرجع العداد للخلف.</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}{success && <p role="status" className="text-emerald-700">{success}</p>}
    {busy && !preview && <p role="status">جارٍ تحميل المعاينة…</p>}
    {preview && <>
      <dl className="grid grid-cols-2 gap-3 rounded-xl border p-4"><dt>الحد الأدنى الحالي</dt><dd dir="ltr">{preview.minimumNext}</dd><dt>قيمة العداد الحالية</dt><dd dir="ltr">{preview.sequenceValue} ({preview.sequenceCalled ? "مستخدم" : "لم يُستخدم"})</dd><dt>أعلى رقم ملف قائم</dt><dd dir="ltr">{preview.maximumCurrent}</dd><dt>أعلى رقم محفوظ من الاستخدام السابق</dt><dd dir="ltr">{preview.maximumRetired}</dd><dt>الرقم التالي حاليًا</dt><dd dir="ltr">{preview.nextNumber ?? "العداد ممتلئ"}</dd></dl>
      {preview.nextNumber !== "P-07000" && <p className="rounded-lg bg-amber-50 p-3">الرقم 7000 ليس نقطة البدء المتاحة الآن. سيكون الرقم التالي <b dir="ltr">{preview.nextNumber ?? "غير متاح: العداد ممتلئ"}</b>؛ لا تُحذف الأرقام السابقة ولا تُستبدل.</p>}
      <form onSubmit={save} className="space-y-4 rounded-xl border p-4">
        <label className="block">حد أدنى جديد (زيادة فقط)<input className="input mt-1 block w-full" dir="ltr" inputMode="numeric" value={floor} onChange={e=>setFloor(e.target.value)} maxLength={19} disabled={busy || preview.exhausted} required /></label>
        <p>بعد الحفظ، أول رقم متاح: <b dir="ltr">{proposed ?? "أدخل رقمًا صحيحًا"}</b>. المعاينة ليست حجزًا؛ إذا أُنشئ ملف آخر يلزم تحديثها.</p>
        <label className="block">سبب التغيير<textarea className="input mt-1 block w-full" value={reason} onChange={e=>setReason(e.target.value)} minLength={3} maxLength={300} disabled={busy || preview.exhausted} required /></label>
        <button className="btn btn-primary min-h-11" disabled={busy || preview.exhausted || !parsedFloor || BigInt(parsedFloor)<=BigInt(preview.minimumNext) || !numberingReason(reason)}>{busy ? "جارٍ الحفظ…" : "حفظ الحد الأدنى الجديد"}</button>
      </form>
    </>}
    <button type="button" className="btn btn-secondary min-h-11" disabled={busy} onClick={load}>تحديث المعاينة</button>
  </main>;
}
