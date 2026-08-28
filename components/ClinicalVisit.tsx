"use client";

import { useCallback, useEffect, useState } from "react";
import { formatAmount, formatMoney, isCurrency, parseAmount, type Currency } from "@/lib/money";
import { CONDITION_LABEL, isValidTooth, toothName } from "@/lib/dental";
import { visitTotal, type ProcedureLine } from "@/lib/clinical";
import { useSetting } from "./SettingsProvider";
import { useSession } from "./SessionProvider";
import { isAdmin } from "@/lib/roles";
import { Icon } from "./Icon";

/**
 * الزيارة السريرية — الشاشة التي تُغلق الحلقة.
 *
 * الطبيب يوثّق ويختار الإجراءات من **دليل الخدمات**، وضغطةُ التوقيع تُنتج الفاتورة
 * وتحدّث المخطط في معاملة واحدة. ولا حقل سعرٍ حرّ بلا خدمة: سعرٌ يُكتب من الذاكرة هو
 * بالضبط ما يجعل المريض يُفوتَر بغير ما اتُّفق عليه.
 */

interface Service { id: number; name: string; category: string | null; priceMinor: number }
interface Doctor { id: number; name: string }
interface Visit {
  id: number; patientId: number | null; patientName: string;
  chiefComplaint: string | null; examination: string | null; diagnosis: string | null;
  treatmentDone: string | null; nextPlan: string | null; addendum: string | null;
  doctorId: number | null; status: "open" | "signed";
  signedAt: string | null; signedBy: string | null; invoiceId: number | null;
  procedures: ProcedureLine[]; totalMinor: number;
}

interface Draft { serviceId: number; toothCode: string; surfaces: string; quantity: number; price: string; doctorId: number | null }

export function ClinicalVisit({ visitId, onSigned }: {
  visitId: number;
  onSigned?: () => void;
}) {
  const baseSetting = useSetting("finance.base_currency");
  const base: Currency = isCurrency(baseSetting) ? baseSetting : "YER";
  const session = useSession();
  const canWrite = isAdmin(session?.role) || session?.role === "doctor";

  const [visit, setVisit] = useState<Visit | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [notes, setNotes] = useState({
    chiefComplaint: "", examination: "", diagnosis: "", treatmentDone: "", nextPlan: "",
  });
  const [doctorId, setDoctorId] = useState<number | null>(null);
  const [addendum, setAddendum] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [visitResponse, serviceResponse, partyResponse] = await Promise.all([
        fetch(`/api/visits/${visitId}/clinical`, { cache: "no-store" }),
        fetch("/api/services", { cache: "no-store" }),
        fetch("/api/parties?kind=doctor", { cache: "no-store" }),
      ]);
      const payload = await visitResponse.json();
      if (!visitResponse.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      const loaded = payload as Visit;
      setVisit(loaded);
      setNotes({
        chiefComplaint: loaded.chiefComplaint ?? "", examination: loaded.examination ?? "",
        diagnosis: loaded.diagnosis ?? "", treatmentDone: loaded.treatmentDone ?? "",
        nextPlan: loaded.nextPlan ?? "",
      });
      setDoctorId(loaded.doctorId);
      setDrafts(loaded.procedures.map((line) => ({
        serviceId: line.serviceId, toothCode: line.toothCode ? String(line.toothCode) : "",
        surfaces: line.surfaces ?? "", quantity: line.quantity,
        price: formatAmount(line.unitPriceMinor, base), doctorId: line.doctorId,
      })));
      if (serviceResponse.ok) setServices(await serviceResponse.json());
      if (partyResponse.ok) {
        const parties = await partyResponse.json();
        setDoctors(Array.isArray(parties) ? parties : parties.balances ?? []);
      }
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    }
  }, [visitId, base]);

  useEffect(() => { void load(); }, [load]);

  const send = useCallback(async (body: Record<string, unknown>) => {
    if (busy) return false;
    setBusy(true);
    try {
      const response = await fetch(`/api/visits/${visitId}/clinical`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) { setError(payload?.message ?? "تعذّر الحفظ."); return false; }
      setError(null);
      await load();
      return true;
    } catch {
      setError("تعذّر الاتصال بالخادم.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy, visitId, load]);

  if (!visit) {
    return <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
      {error ?? "جارٍ التحميل…"}
    </p>;
  }

  const signed = visit.status === "signed";
  const lines = drafts.map((draft) => ({
    quantity: draft.quantity,
    unitPriceMinor: parseAmount(draft.price, base) ?? 0,
  }));
  const total = visitTotal(lines);

  const payload = () => ({
    ...notes, doctorId,
    procedures: drafts.map((draft) => ({
      serviceId: draft.serviceId,
      toothCode: draft.toothCode ? Number(draft.toothCode) : null,
      surfaces: draft.surfaces || null,
      quantity: draft.quantity,
      unitPriceMinor: parseAmount(draft.price, base) ?? 0,
      doctorId: draft.doctorId,
    })),
  });

  return (
    <div>
      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-danger-300 bg-danger-50 px-4 py-2 text-sm font-semibold text-danger-700">{error}</p>
      ) : null}

      <div className={`mb-4 flex flex-wrap items-center gap-2 rounded-2xl border-2 p-3 ${
        signed ? "border-success-300 bg-success-50" : "border-navy-800 bg-white"
      }`}>
        <Icon name={signed ? "check" : "clock"} className={`h-5 w-5 ${signed ? "text-success-700" : "text-navy-800"}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-navy-900">
            {signed ? "زيارة موقَّعة" : "زيارة مفتوحة"} — {visit.patientName}
          </p>
          {signed ? (
            <p className="text-[11px] font-semibold text-slate-500">
              وقّعها {visit.signedBy} · {visit.signedAt?.slice(0, 10)}
              {visit.invoiceId ? ` · فاتورة #${visit.invoiceId}` : " · بلا فاتورة (كشف)"}
            </p>
          ) : null}
        </div>
        {signed && visit.invoiceId ? (
          <a href={`/print/invoice/${visit.invoiceId}`} target="_blank" rel="noopener"
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">
            الفاتورة
          </a>
        ) : null}
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-2">
        <Field label="الشكوى الرئيسية" value={notes.chiefComplaint} disabled={signed}
          onChange={(value) => setNotes((c) => ({ ...c, chiefComplaint: value }))} />
        <Field label="الفحص" value={notes.examination} disabled={signed}
          onChange={(value) => setNotes((c) => ({ ...c, examination: value }))} />
        <Field label="التشخيص" value={notes.diagnosis} disabled={signed}
          onChange={(value) => setNotes((c) => ({ ...c, diagnosis: value }))} />
        <Field label="ما نُفّذ" value={notes.treatmentDone} disabled={signed}
          onChange={(value) => setNotes((c) => ({ ...c, treatmentDone: value }))} />
        <Field label="الخطة القادمة" value={notes.nextPlan} disabled={signed}
          onChange={(value) => setNotes((c) => ({ ...c, nextPlan: value }))} />
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">الطبيب المعالج</span>
          <select value={doctorId ?? ""} disabled={signed}
            onChange={(event) => setDoctorId(Number(event.target.value) || null)}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm disabled:bg-slate-50">
            <option value="">—</option>
            {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
          </select>
        </label>
      </div>

      <section className="mb-4" aria-label="الإجراءات المنفَّذة">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-navy-900">الإجراءات المنفَّذة</h3>
          <span className="text-sm font-extrabold text-navy-900">{formatMoney(total, base)}</span>
        </div>

        {drafts.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-center text-xs font-semibold text-slate-400">
            لا إجراءات. الزيارة بلا إجراء تُوقَّع كشفًا بلا فاتورة.
          </p>
        ) : (
          <ul className="space-y-2">
            {drafts.map((draft, index) => {
              const service = services.find((row) => row.id === draft.serviceId);
              return (
                <li key={index} className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-navy-900">{service?.name ?? "خدمة"}</span>
                    {draft.toothCode ? (
                      <span className="rounded-lg bg-navy-50 px-2 py-0.5 text-[11px] font-bold text-navy-800">
                        {toothName(Number(draft.toothCode))}
                      </span>
                    ) : null}
                    {!signed ? (
                      <button onClick={() => setDrafts((rows) => rows.filter((_, i) => i !== index))}
                        className="mr-auto rounded-lg px-2 py-1 text-[11px] font-bold text-danger-700 hover:bg-danger-50">
                        احذف
                      </button>
                    ) : (
                      <span className="mr-auto text-sm font-bold text-navy-900">
                        {formatMoney(draft.quantity * (parseAmount(draft.price, base) ?? 0), base)}
                      </span>
                    )}
                  </div>
                  {!signed ? (
                    <div className="flex flex-wrap gap-2">
                      <input value={draft.toothCode} inputMode="numeric" dir="ltr"
                        onChange={(event) => setDrafts((rows) => rows.map((row, i) =>
                          i === index ? { ...row, toothCode: event.target.value } : row))}
                        placeholder="السن (FDI)" aria-label="رقم السن"
                        className={`w-24 rounded-xl border px-3 py-2 text-sm ${
                          draft.toothCode && !isValidTooth(Number(draft.toothCode))
                            ? "border-danger-300 bg-danger-50" : "border-slate-200"
                        }`} />
                      <input value={draft.surfaces} dir="ltr"
                        onChange={(event) => setDrafts((rows) => rows.map((row, i) =>
                          i === index ? { ...row, surfaces: event.target.value } : row))}
                        placeholder="الأسطح" aria-label="الأسطح"
                        className="w-24 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
                      <input value={draft.quantity} type="number" min={1} dir="ltr"
                        onChange={(event) => setDrafts((rows) => rows.map((row, i) =>
                          i === index ? { ...row, quantity: Math.max(1, Number(event.target.value) || 1) } : row))}
                        aria-label="الكمية"
                        className="w-20 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
                      <input value={draft.price} inputMode="decimal" dir="ltr"
                        onChange={(event) => setDrafts((rows) => rows.map((row, i) =>
                          i === index ? { ...row, price: event.target.value } : row))}
                        aria-label="السعر"
                        className="min-w-[6rem] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold" />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {!signed && canWrite ? (
          <select value="" aria-label="أضف إجراءً"
            onChange={(event) => {
              const service = services.find((row) => row.id === Number(event.target.value));
              if (!service) return;
              // السعر يأتي من الدليل لا من الذاكرة — ويجوز تعديله بعدها بمبرّر.
              setDrafts((rows) => [...rows, {
                serviceId: service.id, toothCode: "", surfaces: "", quantity: 1,
                price: formatAmount(service.priceMinor, base), doctorId,
              }]);
            }}
            className="mt-2 w-full rounded-xl border-2 border-dashed border-slate-300 bg-white px-3 py-2.5 text-sm font-bold text-navy-800">
            <option value="">+ أضف إجراءً من دليل الخدمات</option>
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name} — {formatAmount(service.priceMinor, base)}
              </option>
            ))}
          </select>
        ) : null}
      </section>

      {signed ? (
        <section aria-label="الملاحق">
          {visit.addendum ? (
            <pre className="mb-3 whitespace-pre-wrap rounded-xl border border-warning-300 bg-warning-50 p-3 text-[11px] font-semibold leading-5 text-warning-900">
              {visit.addendum}
            </pre>
          ) : null}
          {canWrite ? (
            <>
              <textarea value={addendum} onChange={(event) => setAddendum(event.target.value)}
                rows={2} placeholder="ملحق تصحيحي — يُضاف ولا يمحو ما قبله"
                aria-label="ملحق"
                className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
              <button
                onClick={async () => {
                  if (await send({ action: "addendum", text: addendum })) setAddendum("");
                }}
                disabled={busy || !addendum.trim()}
                className="rounded-xl border border-warning-300 bg-warning-50 px-4 py-2 text-sm font-bold text-warning-900 disabled:opacity-40">
                أضف ملحقًا
              </button>
            </>
          ) : null}
        </section>
      ) : canWrite ? (
        <div className="flex flex-wrap gap-2">
          <button onClick={() => void send(payload())} disabled={busy}
            className="flex-1 rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-bold text-navy-800 disabled:opacity-40">
            احفظ بلا توقيع
          </button>
          <button
            onClick={async () => {
              // الحفظ ثم التوقيع: توقيعٌ يترك ما كُتب في الشاشة غير محفوظ يفقد العمل.
              if (await send(payload())) {
                if (await send({ action: "sign" })) onSigned?.();
              }
            }}
            disabled={busy}
            className="flex-[2] rounded-xl bg-navy-900 py-2.5 text-sm font-extrabold text-white disabled:opacity-40">
            وقّع الزيارة{total > 0 ? ` وأصدر فاتورة ${formatMoney(total, base)}` : ""}
          </button>
        </div>
      ) : (
        <p className="text-[11px] font-semibold text-slate-400">التوثيق السريري يُكتب من الطبيب.</p>
      )}

      {!signed && canWrite ? (
        <p className="mt-2 text-[10px] font-semibold leading-4 text-slate-400">
          التوقيع يُنتج الفاتورة ويحدّث المخطط السني في عملية واحدة. وبعده لا تُعدَّل
          الزيارة — التصحيح بملحق يحمل كاتبه ووقته.
        </p>
      ) : null}
    </div>
  );
}

function Field({ label, value, onChange, disabled }: {
  label: string; value: string; onChange: (value: string) => void; disabled: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold text-slate-500">{label}</span>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={2} disabled={disabled}
        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue disabled:bg-slate-50 disabled:text-slate-500" />
    </label>
  );
}
