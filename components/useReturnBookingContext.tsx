"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "./SessionProvider";

import { parseReturnBookingSource, type ReturnBookingSource } from "@/lib/return-booking-source";
type SettingsTarget = { kind: "clinical" | "ortho"; id: number };
type ContextOption = { source: ReturnBookingSource; label: string; doctorId: number | null; doctorName: string | null; settingsTarget: SettingsTarget; available: boolean };
type Verified = { ok: true; patientId: number; source: ReturnBookingSource; doctorId: number; doctorName: string; fingerprint: string; settingsTarget?: SettingsTarget; label?: string };
/** Display only: who is suggested while responsibility awaits confirmation. Never a booking authority. */
type Pending = { doctorName: string | null; message: string };
type Read = { scope: string; verified: Verified | null; contexts: ContextOption[]; message: string | null; settingsTarget?: SettingsTarget; pending?: Pending | null };
const readPending = (value: unknown): Pending | null => {
  if (!value || typeof value !== "object") return null;
  const { doctorName, message } = value as { doctorName?: unknown; message?: unknown };
  if (typeof message !== "string" || !message.trim()) return null;
  return { doctorName: typeof doctorName === "string" && doctorName.trim() ? doctorName : null, message };
};
const sourceKey = (source?: ReturnBookingSource | null) => source ? `${source.kind}:${source.id}` : "";
const isSource = (source: unknown): source is ReturnBookingSource => parseReturnBookingSource(source) !== null;
const isSettings = (value: unknown): value is SettingsTarget => !!value && typeof value === "object"
  && ["clinical", "ortho"].includes((value as SettingsTarget).kind) && Number.isSafeInteger((value as SettingsTarget).id) && (value as SettingsTarget).id > 0;

/** Only a clinical-context choice is allowed. The clinician is authoritative server data. */
export function useReturnBookingContext({ patientId, source, enabled, locked = false }: {
  patientId?: number | null; source?: ReturnBookingSource | null; enabled: boolean; locked?: boolean;
}) {
  const session = useSession();
  const baseScope = JSON.stringify([session?.username, session?.role, session?.permissions, enabled, patientId, sourceKey(source)]);
  const [choice, setChoice] = useState<{ scope: string; source: ReturnBookingSource } | null>(null);
  const selected = choice?.scope === baseScope ? choice.source : source ?? null;
  const [optionsRead, setOptionsRead] = useState<{ scope: string; contexts: ContextOption[] } | null>(null);
  const selectedKey = sourceKey(selected);
  const originQuery = source && sourceKey(source) !== selectedKey ? `&originKind=${source.kind}&originId=${source.id}` : "";
  const query = selected ? `?kind=${selected.kind}&sourceId=${selected.id}${originQuery}` : "";
  const [revision, setRevision] = useState(0);
  const scope = JSON.stringify([baseScope, sourceKey(selected), revision]);
  const [read, setRead] = useState<Read | null>(null);
  const lifetime = useRef({ scope, live: true });
  if (lifetime.current.scope !== scope) { lifetime.current.live = false; lifetime.current = { scope, live: true }; }
  const current = read?.scope === scope ? read : null;
  const verified = current?.verified ?? null;
  useEffect(() => {
    const owner = lifetime.current; owner.live = true;
    const controller = new AbortController();
    const fail = (message: string) => { if (owner.live && lifetime.current === owner) setRead({ scope, verified: null, contexts: [], message }); };
    const timeout = setTimeout(() => { controller.abort(); fail("تعذّر التحقق من الطبيب المسؤول في الوقت المحدد. أعد المحاولة."); }, 15_000);
    if (enabled && Number.isSafeInteger(patientId) && Number(patientId) > 0) void (async () => {
      try {
        const response = await fetch(`/api/patients/${patientId}/return-booking-context${query}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json().catch(() => null);
        if (!owner.live || lifetime.current !== owner || controller.signal.aborted) return;
        if (response.status === 401 || response.status === 403) {
          setOptionsRead({ scope: baseScope, contexts: [] });
          setRead({ scope, verified: null, contexts: [], message: "انتهت الجلسة أو تغيّرت صلاحية هذا الملف. أعد التحقق من الوصول قبل الحجز." });
          return;
        }
        const valid = response.ok && data?.ok === true && data.patientId === patientId && isSource(data.source)
          && sourceKey(data.source) === selectedKey && Number.isSafeInteger(data.doctorId) && data.doctorId > 0
          && typeof data.doctorName === "string" && data.doctorName.trim() && typeof data.fingerprint === "string" && /^[a-f0-9]{64}$/.test(data.fingerprint);
        const contexts: ContextOption[] = Array.isArray(data?.contexts) ? data.contexts.filter((item: ContextOption) => item && isSource(item.source)
          && ["clinical_case", "ortho_case"].includes(item.source.kind) && typeof item.label === "string" && isSettings(item.settingsTarget)) : [];
        if (contexts.length || !selectedKey) setOptionsRead({ scope: baseScope, contexts });
        const target = isSettings(data?.settingsTarget) ? data.settingsTarget : contexts.find(item => sourceKey(item.source) === selectedKey)?.settingsTarget ?? (contexts.length === 1 ? contexts[0].settingsTarget : undefined);
        setRead({ scope, verified: valid ? data : null, contexts,
          message: valid || (!selectedKey && response.ok) ? null : typeof data?.message === "string" ? data.message : "تعذّر التحقق من سياق الحالة والطبيب المسؤول.", settingsTarget: target,
          pending: !valid && data?.code === "responsibility_missing" ? readPending(data.responsibilitySuggestion) : null });
      } catch { if (!controller.signal.aborted) fail("تعذّر تحميل الطبيب المسؤول. أعد المحاولة."); }
      finally { clearTimeout(timeout); }
    })();
    else clearTimeout(timeout);
    return () => { owner.live = false; controller.abort(); clearTimeout(timeout); };
  }, [scope, baseScope, enabled, patientId, query, selectedKey]);
  const refresh = () => setRevision(value => value + 1);
  const handleRejection = (payload: unknown) => {
    const code = payload && typeof payload === "object" ? (payload as { code?: unknown }).code : null;
    if (typeof code === "string" && (code.startsWith("return_source_") || code.startsWith("responsibility_") || code === "ortho_booking_source_changed" || code === "return_booking_source_changed")) {
      lifetime.current.live = false; refresh();
    }
  };
  const target = verified?.settingsTarget ?? current?.settingsTarget;
  const settingsHref = target && patientId ? `/patients/${patientId}?tab=treatment&sub=${target.kind === "ortho" ? "ortho" : "cases"}&patientId=${patientId}&${target.kind === "ortho" ? "orthoCaseId" : "clinicalCaseId"}=${target.id}` : null;
  const options = optionsRead?.scope === baseScope ? optionsRead.contexts : current?.contexts ?? [];
  const view = !enabled ? null : <section aria-label="الطبيب المسؤول عن موعد المراجعة" className="my-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-navy-950" dir="rtl">
    {!source || options.length > 1 || sourceKey(selected) !== sourceKey(source) ? <label className="block text-xs font-bold">الحالة التي تخصها المراجعة
      <select disabled={locked} aria-label="سياق موعد المراجعة" value={sourceKey(selected)} className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2"
        onChange={event => { const option = options.find(item => sourceKey(item.source) === event.target.value); setChoice(option ? { scope: baseScope, source: option.source } : null); }}>
        <option value="">اختر الحالة المقصودة</option>
        {options.map(item => <option key={sourceKey(item.source)} value={sourceKey(item.source)}>{item.label}</option>)}
        {selected && !options.some(item => sourceKey(item.source) === sourceKey(selected)) ? <option value={sourceKey(selected)}>{verified?.label ?? "الحالة المحددة"}</option> : null}
      </select>
    </label> : null}
    {verified ? <p className="font-bold">الطبيب المسؤول الحالي: {verified.doctorName}</p>
      : <p role="status" className="mt-1 text-xs">{!patientId ? "اختر ملف المريض وسياق الحالة قبل حجز المراجعة." : current?.message ?? (current && !selected ? "اختر الحالة لتحديد طبيبها المسؤول، وليس طبيبًا بديلًا لهذا الموعد فقط." : "جارٍ التحقق من الطبيب المسؤول…")}</p>}
    {!verified && current?.pending ? <p role="note" data-testid="responsibility-pending" className="mt-1 text-xs font-bold text-amber-900">
      {current.pending.doctorName ? `مقترح: ${current.pending.doctorName} — ${current.pending.message}` : current.pending.message}</p> : null}
    {!verified && current ? <div className="mt-2 flex flex-wrap gap-3 text-xs">
      <button type="button" disabled={locked} onClick={refresh} className="min-h-9 rounded-lg border border-sky-300 bg-white px-3 font-bold">تحديث الطبيب المسؤول</button>
      {settingsHref ? <a href={settingsHref} className="min-h-9 rounded-lg border border-sky-300 bg-white px-3 py-2 font-bold">إعداد الطبيب المسؤول للحالة</a>
        : patientId ? <a href={`/patients/${patientId}?tab=treatment&sub=cases`} className="py-2 font-bold underline">مراجعة سياق الحالة ومسؤوليتها</a> : null}
      <span>تُعتمد المسؤولية من إعدادات الحالة بواسطة الإدارة أو من تمنحه الصلاحية؛ لا يُختار طبيب عابر لهذا الموعد.</span>
    </div> : null}
  </section>;
  return { ready: !enabled || !!verified, verified, view, refresh, handleRejection,
    fingerprint: verified?.fingerprint ?? null,
    intrinsicPayload: verified ? { returnBookingSource: verified.source, returnBookingFingerprint: verified.fingerprint } : {},
    payload: verified ? { returnBookingSource: verified.source, returnBookingFingerprint: verified.fingerprint,
      ...(source && sourceKey(source) !== sourceKey(verified.source) ? { returnBookingOrigin: source } : {}) } : {},
    isCurrent: () => !enabled || !!verified && lifetime.current.live && lifetime.current.scope === scope,
  };
}
