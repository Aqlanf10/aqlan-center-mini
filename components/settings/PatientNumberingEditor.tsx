"use client";

import { useRef, useState, type FormEvent } from "react";

import type { PatientNumberingSnapshot } from "@/lib/patient-numbering";
import { canonicalPatientPrefix, LEGACY_NUMBER_MAX, MANAGED_NUMBER_MAX, patientNumberDigits, patientNumberFloor } from "@/lib/patient-numbering-input";

export function PatientNumberingEditor({ initial, onSaved }: {
  initial: PatientNumberingSnapshot;
  onSaved: (next: PatientNumberingSnapshot) => void;
}) {
  const [prefix, setPrefix] = useState(initial.prefix);
  const [firstNumber, setFirstNumber] = useState(initial.nextNumber);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const inFlight = useRef(false);
  const attempt = useRef<{ prefix: string; firstNumber: string; requestId: string } | null>(null);
  const digits = patientNumberDigits(firstNumber);
  const switchingSeries = initial.perPrefix === true && prefix !== initial.prefix;
  const minimum = switchingSeries ? patientNumberFloor(prefix, true) : BigInt(initial.nextNumber);
  const maximum = initial.perPrefix ? MANAGED_NUMBER_MAX : LEGACY_NUMBER_MAX;
  const exhausted = BigInt(initial.nextNumber) > maximum;
  const valid = canonicalPatientPrefix(prefix) !== null && /^[1-9]\d{0,18}$/.test(digits)
    && BigInt(digits) >= minimum && BigInt(digits) <= maximum;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !valid) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setConfirmation("");
    if (!attempt.current || attempt.current.prefix !== prefix || attempt.current.firstNumber !== digits) {
      attempt.current = { prefix, firstNumber: digits, requestId: crypto.randomUUID() };
    }
    const body = attempt.current;
    try {
      const response = await fetch("/api/settings/patient-numbering", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.message || "تعذّر حفظ ترقيم الملفات.");
      if (result?.prefix !== prefix || result?.nextNumber !== digits || (result?.perPrefix === true) !== (initial.perPrefix === true)) {
        throw new Error("تعذّر تأكيد الحفظ. أعد المحاولة.");
      }
      attempt.current = null;
      onSaved({ prefix: result.prefix, nextNumber: result.nextNumber, ...(initial.perPrefix && { perPrefix: true }) });
      setPrefix(result.prefix);
      setFirstNumber(result.nextNumber);
      setConfirmation(`حُفظ طلب الترقيم بدءًا من ${prefix}-${digits.padStart(5, "0")} للملفات الجديدة.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "تعذّر حفظ ترقيم الملفات.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const field = "mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm";
  return (
    <form onSubmit={save} aria-label="ترقيم ملفات المرضى الجديدة" className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-black text-navy-950">ترقيم ملفات المرضى الجديدة</h2>
      <p className="mt-1 text-xs text-slate-600">تحتفظ الملفات السابقة بأرقامها. {switchingSeries
        ? "سيتحقق النظام عند الحفظ من الرقم المتاح للبادئة المختارة."
        : exhausted ? "استُنفد نطاق الترقيم الحالي."
        : <>أدنى رقم عند آخر تحديث هو <bdi>{initial.nextNumber}</bdi>.</>}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label>البادئة (١–٦ أحرف لاتينية)
          <input dir="ltr" value={prefix} disabled={busy} className={field} required
            onChange={event => { setPrefix(canonicalPatientPrefix(event.target.value) ?? event.target.value); setConfirmation(""); setError(""); }} />
        </label>
        <label>أول رقم للملفات الجديدة
          <input dir="ltr" inputMode="numeric" maxLength={24} value={firstNumber} disabled={busy} className={field} required
            onChange={event => { setFirstNumber(event.target.value); setConfirmation(""); setError(""); }} />
        </label>
      </div>
      {valid
        ? <p className="mt-2 text-xs">أول رقم مطلوب <bdi>{prefix}-{digits.padStart(5, "0")}</bdi></p>
        : <p className="mt-2 text-xs text-red-700">تحقق من البادئة وأدخل عددًا صحيحًا ضمن النطاق المتاح.</p>}
      {error ? <p role="alert" className="mt-2 text-xs text-red-700">{error}</p> : null}
      {confirmation ? <p role="status" className="mt-2 text-xs text-emerald-700">{confirmation}</p> : null}
      <button type="submit" disabled={busy || !valid}
        className="mt-3 rounded-xl bg-brand-blue px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
        حفظ ترقيم الملفات
      </button>
    </form>
  );
}
