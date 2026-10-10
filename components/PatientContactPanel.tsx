"use client";

import { useCallback, useEffect, useState } from "react";
import { useSetting } from "@/components/SettingsProvider";
import type { Patient } from "@/lib/patient";
import {
  CONSENT_CHANNELS, CONSENT_CHANNEL_LABEL, CONSENT_SOURCE_LABEL, MANUAL_CONSENT_SOURCES, PREFERRED_CHANNELS,
  PREFERRED_CHANNEL_LABEL, flagClass, parseFlagList,
  type ConsentChannel, type ConsentMode, type ConsentSource, type ConsentState,
} from "@/lib/patient-identity";

/**
 * (PAT-3) هوية المريض وتواصله في ملفه: الأعلام، البريد والقناة المفضّلة، وموافقة التواصل
 * لكل قناة بسجلٍّ مؤرَّخ — ما تحترمه وحدة الرسائل والتذكير الآلي قبل أي إرسال.
 */

interface ConsentEvent {
  id: number; channel: ConsentChannel; granted: boolean; source: ConsentSource;
  note: string | null; recordedBy: string; recordedAt: string;
}

interface ConsentPayload {
  mode: ConsentMode;
  states: Record<ConsentChannel, ConsentState>;
  history: ConsentEvent[];
  canRecord: boolean;
}

const STATE_LABEL: Record<ConsentState, string> = { granted: "موافق", withdrawn: "سحب موافقته", unknown: "لم تُسجَّل" };
const STATE_CLASS: Record<ConsentState, string> = {
  granted: "border-emerald-200 bg-emerald-50 text-emerald-800",
  withdrawn: "border-rose-200 bg-rose-50 text-rose-800",
  unknown: "border-slate-200 bg-slate-50 text-slate-600",
};

const dateText = (iso: string) => new Date(iso).toLocaleDateString("ar-YE-u-nu-latn");

/** شارات الأعلام — للترويسة وأي شاشة تعرض المريض. */
export function PatientFlagChips({ flags }: { flags: readonly string[] | undefined }) {
  const list = parseFlagList(useSetting("patients.flags"));
  if (!flags || flags.length === 0) return null;
  return (
    <>
      {flags.map((flag) => (
        <span key={flag} className={`inline-flex items-center rounded-lg border px-2 py-0.5 text-[11px] font-black ${flagClass(flag, list)}`}
          title={list.includes(flag) ? "علَم المريض" : "علَمٌ لم يعد في قائمة الإعدادات"}>
          🏷️ {flag}
        </span>
      ))}
    </>
  );
}

export function PatientContactPanel({ patient, canEdit, onPatientChange }: {
  patient: Patient;
  canEdit: boolean;
  onPatientChange: (patient: Patient) => void;
}) {
  const flagList = parseFlagList(useSetting("patients.flags"));
  const [consent, setConsent] = useState<ConsentPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState(patient.email ?? "");
  const [source, setSource] = useState<ConsentSource>("in_person");
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => { setEmail(patient.email ?? ""); }, [patient.email]);

  const loadConsent = useCallback(async () => {
    try {
      const response = await fetch(`/api/patients/${patient.id}/contact`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message ?? "تعذّر تحميل موافقات التواصل.");
      setConsent(payload as ConsentPayload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر تحميل موافقات التواصل.");
    }
  }, [patient.id]);

  useEffect(() => { void loadConsent(); }, [loadConsent]);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/patients/${patient.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message ?? "تعذّر الحفظ.");
      onPatientChange(payload as Patient);
      setError(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "تعذّر الحفظ.");
    } finally {
      setBusy(false);
    }
  };

  const toggleFlag = (flag: string) => {
    const current = patient.flags ?? [];
    void patch({ flags: current.includes(flag) ? current.filter((item) => item !== flag) : [...current, flag] });
  };

  const recordConsent = async (channel: ConsentChannel, granted: boolean) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/patients/${patient.id}/contact`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, granted, source }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message ?? "تعذّر حفظ الموافقة.");
      setError(null);
      await loadConsent();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "تعذّر حفظ الموافقة.");
    } finally {
      setBusy(false);
    }
  };

  // الأعلام المعروضة للاختيار: قائمة الإعداد + ما على المريض وخرج منها (ليُزال إن شاء).
  const flagOptions = Array.from(new Set([...flagList, ...(patient.flags ?? [])]));

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs" aria-label="الهوية والتواصل">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-black text-navy-900">🏷️ الأعلام والتواصل</h2>
        {consent ? (
          <span className="text-[11px] font-bold text-slate-500">
            {consent.mode === "opt_in" ? "المراسلة بموافقة مسجّلة فقط" : "يُراسَل ما لم يطلب الإيقاف"}
          </span>
        ) : null}
      </div>

      {error ? <p role="alert" className="mb-3 rounded-xl bg-rose-50 p-2 text-xs font-bold text-rose-700">{error}</p> : null}

      {/* الأعلام */}
      <div className="mb-4">
        <p className="mb-1.5 text-xs font-bold text-slate-600">الأعلام</p>
        <div className="flex flex-wrap gap-1.5">
          {flagOptions.map((flag) => {
            const active = (patient.flags ?? []).includes(flag);
            return (
              <button key={flag} type="button" disabled={!canEdit || busy} onClick={() => toggleFlag(flag)} aria-pressed={active}
                className={`rounded-lg border px-2 py-1 text-xs font-bold transition disabled:cursor-default ${
                  active ? flagClass(flag, flagList) : "border-dashed border-slate-300 bg-white text-slate-400 hover:bg-slate-50"}`}>
                {active ? "✓ " : "+ "}{flag}
              </button>
            );
          })}
          {flagOptions.length === 0 ? <span className="text-xs text-slate-400">لا أعلام في الإعدادات.</span> : null}
        </div>
      </div>

      {/* البريد والقناة المفضّلة */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="min-w-0 text-xs font-bold text-slate-600">
          البريد الإلكتروني
          <div className="mt-1 flex gap-1.5">
            <input type="email" dir="ltr" value={email} disabled={!canEdit || busy} onChange={(event) => setEmail(event.target.value)}
              placeholder="name@example.com"
              className="min-w-0 w-full flex-1 rounded-xl border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brand-blue" />
            {canEdit && email.trim() !== (patient.email ?? "") ? (
              <button type="button" disabled={busy} onClick={() => void patch({ email: email.trim() })}
                className="rounded-xl bg-navy-800 px-3 text-xs font-bold text-white disabled:opacity-50">حفظ</button>
            ) : null}
          </div>
        </label>
        <label className="min-w-0 text-xs font-bold text-slate-600">
          القناة المفضّلة
          <select value={patient.preferredChannel ?? ""} disabled={!canEdit || busy}
            onChange={(event) => void patch({ preferredChannel: event.target.value || null })}
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-blue">
            <option value="">غير محددة</option>
            {PREFERRED_CHANNELS.map((channel) => <option key={channel} value={channel}>{PREFERRED_CHANNEL_LABEL[channel]}</option>)}
          </select>
        </label>
      </div>

      {/* موافقات التواصل */}
      <div>
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-bold text-slate-600">موافقة المريض على المراسلة</p>
          {consent?.canRecord ? (
            <label className="flex items-center gap-1 text-[11px] font-bold text-slate-500">
              كيف أُخذت:
              <select value={source} onChange={(event) => setSource(event.target.value as ConsentSource)}
                className="rounded-lg border border-slate-300 bg-white px-2 py-0.5 text-[11px]">
                {MANUAL_CONSENT_SOURCES.map((item) => <option key={item} value={item}>{CONSENT_SOURCE_LABEL[item]}</option>)}
              </select>
            </label>
          ) : null}
        </div>
        {consent ? (
          <div className="grid gap-2 sm:grid-cols-3">
            {CONSENT_CHANNELS.map((channel) => {
              const state = consent.states[channel];
              return (
                <div key={channel} className={`rounded-xl border p-2 ${STATE_CLASS[state]}`}>
                  <p className="text-xs font-black">{CONSENT_CHANNEL_LABEL[channel]}</p>
                  <p className="text-[11px] font-bold">{STATE_LABEL[state]}</p>
                  {consent.canRecord ? (
                    <div className="mt-1.5 flex gap-1">
                      {state !== "granted" ? (
                        <button type="button" disabled={busy} onClick={() => void recordConsent(channel, true)}
                          className="rounded-lg bg-white/80 px-2 py-0.5 text-[11px] font-bold text-emerald-700 ring-1 ring-emerald-200 disabled:opacity-50">
                          وافق
                        </button>
                      ) : null}
                      {state !== "withdrawn" ? (
                        <button type="button" disabled={busy} onClick={() => void recordConsent(channel, false)}
                          className="rounded-lg bg-white/80 px-2 py-0.5 text-[11px] font-bold text-rose-700 ring-1 ring-rose-200 disabled:opacity-50">
                          أوقف المراسلة
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : error ? null : <p className="text-xs text-slate-400">جارٍ التحميل…</p>}

        {consent && consent.history.length > 0 ? (
          <div className="mt-2">
            <button type="button" onClick={() => setShowHistory((open) => !open)} className="text-[11px] font-bold text-brand-blue">
              {showHistory ? "إخفاء السجل" : `سجل الموافقات (${consent.history.length})`}
            </button>
            {showHistory ? (
              <ul className="mt-1.5 space-y-1 text-[11px] text-slate-600">
                {consent.history.map((event) => (
                  <li key={event.id} className="flex flex-wrap gap-x-2">
                    <span className="font-bold">{dateText(event.recordedAt)}</span>
                    <span>{CONSENT_CHANNEL_LABEL[event.channel]}: {event.granted ? "منح" : "سحب"}</span>
                    <span className="text-slate-400">({CONSENT_SOURCE_LABEL[event.source]} — {event.recordedBy})</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

