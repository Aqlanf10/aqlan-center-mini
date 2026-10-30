"use client";
import { useState } from "react";
type SavedRx = { id: number; visitId: number | null; createdAt: string; prescribingDoctorName: string | null };
export function SavedPrescriptions({ patientId, visitId }: { patientId: number; visitId?: number }) {
  const [rows, setRows] = useState<SavedRx[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true); setError(null); setRows(null);
    try {
      const response = await fetch(`/api/patients/${patientId}/prescriptions/saved${visitId ? `?visitId=${visitId}` : ""}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "تعذرت قراءة الوصفات.");
      if (!Array.isArray(body.prescriptions)) throw new Error("استجابة الوصفات غير صالحة.");
      setRows(body.prescriptions);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذرت قراءة الوصفات."); }
    finally { setBusy(false); }
  };
  return <details className="my-3 rounded-xl border bg-white p-3" onToggle={event => { if (event.currentTarget.open) void load(); }}>
    <summary className="cursor-pointer font-bold">الوصفات المحفوظة — إعادة الطباعة{visitId ? ` للزيارة #${visitId}` : ""}</summary>
    <p className="my-2 text-xs text-slate-600">تُطبع النسخة المحفوظة باسم طبيبها الأصلي. الوصفات الملغاة غير متاحة للصرف.</p>
    <button type="button" onClick={() => void load()} disabled={busy} className="rounded border px-3 py-1">تحديث القائمة</button>
    {busy && <p role="status">جارٍ قراءة الوصفات…</p>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {rows?.length === 0 && <p>لا توجد وصفات محفوظة فاعلة لهذا السياق.</p>}
    {rows?.length === 50 && <p className="text-xs text-slate-600">تُعرض أحدث 50 وصفة فاعلة في السياق المحدد.</p>}
    <ul>{rows?.map(rx => <li key={rx.id} className="my-2 flex flex-wrap items-center gap-3 border-t pt-2">
      <span>وصفة #{rx.id} — <bdi>{rx.createdAt.slice(0, 10)}</bdi> — {rx.prescribingDoctorName || "اسم الطبيب غير موثق في السجل القديم"}</span>
      <span>{rx.visitId ? `زيارة #${rx.visitId}` : "دون ربط موثق بزيارة"}</span>
      <a className="rounded border px-3 py-1 font-bold" href={`/print/prescription/${patientId}?rx=${rx.id}`} target="_blank" rel="noopener noreferrer">فتح الوصفة للطباعة</a>
    </li>)}</ul>
  </details>;
}
