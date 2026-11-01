"use client";
import { useEffect, useRef, useState } from "react";
import { useSession } from "./SessionProvider";
import { SavedPrescriptionRow, type SavedRx } from "./SavedPrescriptionRow";
export function SavedPrescriptions({ patientId, visitId }: { patientId: number; visitId?: number }) {
  const session = useSession();
  return <SavedPrescriptionList key={JSON.stringify([patientId, visitId, session?.username, session?.role, session?.permissions])} patientId={patientId} visitId={visitId} />;
}
function SavedPrescriptionList({ patientId, visitId }: { patientId: number; visitId?: number }) {
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, []);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [rows, setRows] = useState<SavedRx[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clinicalHistory, setClinicalHistory] = useState(false);
  const load = async (more = false) => {
    if (request.current || (more && !nextCursor)) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(null);
    if (!more) { setRows(null); setNextCursor(null); setClinicalHistory(false); }
    try {
      const query = new URLSearchParams();
      if (visitId) query.set("visitId", String(visitId));
      if (more && nextCursor) query.set("cursor", nextCursor);
      const response = await fetch(`/api/patients/${patientId}/prescriptions/saved?${query}`, { cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted) return;
      if ([401, 403, 404].includes(response.status)) { setRows(null); setNextCursor(null); setClinicalHistory(false); }
      const body = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) {
        throw new Error(body.message || "تعذرت قراءة الوصفات.");
      }
      if (!Array.isArray(body.prescriptions) || !(body.nextCursor === null || typeof body.nextCursor === "string")) throw new Error("استجابة الوصفات غير صالحة.");
      setClinicalHistory(body.mode === "clinical-history");
      setRows(previous => more && (body.mode === "clinical-history") === clinicalHistory ? [...(previous ?? []), ...body.prescriptions] : body.prescriptions);
      setNextCursor(body.nextCursor);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "تعذرت قراءة الوصفات.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (request.current === controller) request.current = null;
    }
  };
  return <details className="my-3 rounded-xl border bg-white p-3" onToggle={event => { if (event.currentTarget.open) void load(); }}>
    <summary className="cursor-pointer font-bold">الوصفات المحفوظة{visitId ? ` للزيارة #${visitId}` : ""}</summary>
    <p className="my-2 text-xs text-slate-600">تُعرض النسخة المحفوظة باسم طبيبها الأصلي. «مصدرة» لا تعني أن الدواء صُرف من الصيدلية.</p>
    {clinicalHistory && <p className="my-2 text-xs text-slate-600">سجل الوصفات المصدرة والمبطلة؛ التاريخ والوقت بتوقيت العيادة، ولا تُعدّل النسخة المحفوظة بعد الإصدار.</p>}
    <button type="button" onClick={() => void load()} disabled={busy} className="rounded border px-3 py-1">تحديث القائمة</button>
    {busy && <p role="status">جارٍ قراءة الوصفات…</p>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {rows?.length === 0 && <p>{clinicalHistory ? "لا توجد وصفات مصدرة أو مبطلة لهذا السياق." : "لا توجد وصفات محفوظة فاعلة متاحة لإعادة الطباعة لهذا السياق."}</p>}

    <ul>{rows?.map(rx => <SavedPrescriptionRow key={rx.id} rx={rx} patientId={patientId} />)}</ul>
    {nextCursor && <button type="button" onClick={() => void load(true)} disabled={busy} className="rounded border px-3 py-1">تحميل المزيد من الوصفات</button>}
  </details>;
}
