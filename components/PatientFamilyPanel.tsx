"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { FamilyView } from "@/lib/family-view";
import { FAMILY_ROLES, FAMILY_ROLE_LABEL, type FamilyRole } from "@/lib/patient-families";
import { CURRENCY_LABEL, formatMoney, type Currency } from "@/lib/money";

/**
 * (PAT-4) لوحة «العائلة» في ملف المريض: الأفراد (رابطٌ وصلة)، والضامن، ولمن يرى المال وحده رصيد كل
 * فردٍ بكل عملة ومجموعٌ لكل عملةٍ على حدة. الضامن معلومةٌ وكشفٌ فقط — لا سند عائلي ولا توزيع.
 * الكتابة للاستقبال والإدارة (الخادم يفرضها).
 */

interface Payload { family: FamilyView | null; canEdit: boolean }
interface PatientHit { id: number; patientNumber: string; fullName: string; phone: string | null }
interface FamilyHit { id: number; name: string; memberCount: number }

function balanceLabel(minor: number, currency: Currency): string {
  if (minor === 0) return `${CURRENCY_LABEL[currency]}: مسدّد`;
  return minor > 0 ? `عليه ${formatMoney(minor, currency)}` : `له ${formatMoney(-minor, currency)}`;
}

function RoleSelect({ value, onChange, disabled, label }: {
  value: FamilyRole | null; onChange: (role: FamilyRole | null) => void; disabled?: boolean; label: string;
}) {
  return (
    <select aria-label={label} value={value ?? ""} disabled={disabled}
      onChange={(event) => onChange((event.target.value || null) as FamilyRole | null)}
      className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs">
      <option value="">الصلة…</option>
      {FAMILY_ROLES.map((role) => <option key={role} value={role}>{FAMILY_ROLE_LABEL[role]}</option>)}
    </select>
  );
}

async function send(url: string, method: string, body?: unknown): Promise<FamilyView> {
  const response = await fetch(url, {
    method, headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message ?? "تعذّر الحفظ.");
  return payload as FamilyView;
}

export function PatientFamilyPanel({ patientId, patientName, patientPhone }: {
  patientId: number; patientName: string; patientPhone: string | null;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"idle" | "create" | "join" | "add" | "guarantor" | "rename">("idle");
  const [role, setRole] = useState<FamilyRole | null>(null);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [familyHits, setFamilyHits] = useState<FamilyHit[]>([]);
  const [patientHits, setPatientHits] = useState<PatientHit[]>([]);
  const [suggestions, setSuggestions] = useState<FamilyHit[]>([]);
  const [guarantorKind, setGuarantorKind] = useState<"none" | "patient" | "external">("none");
  const [guarantorPatient, setGuarantorPatient] = useState<number | null>(null);
  const [guarantorName, setGuarantorName] = useState("");
  const [guarantorPhone, setGuarantorPhone] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/patients/${patientId}/family`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message ?? "تعذّر تحميل العائلة.");
      setData(payload as Payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر تحميل العائلة.");
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  /* بلا عائلة: عائلاتٌ يطابق جوالُ أحد أفرادها جوالَ المريض — اقتراحٌ لا ربط. */
  useEffect(() => {
    if (!data?.canEdit || data.family || !patientPhone) return;
    let cancelled = false;
    void fetch(`/api/families?phone=${encodeURIComponent(patientPhone)}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { suggestions: [] }))
      .then((payload: { suggestions?: { familyId: number; name: string; memberCount: number }[] }) => {
        if (!cancelled) setSuggestions((payload.suggestions ?? []).map((s) => ({ id: s.familyId, name: s.name, memberCount: s.memberCount })));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [data?.canEdit, data?.family, patientPhone]);

  const run = async (action: () => Promise<FamilyView | null>) => {
    setBusy(true);
    try {
      await action();
      setError(null);
      setMode("idle");
      setQuery("");
      setFamilyHits([]);
      setPatientHits([]);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "تعذّر الحفظ.");
    } finally {
      setBusy(false);
    }
  };

  const search = async (term: string, kind: "family" | "patient") => {
    setQuery(term);
    if (term.trim().length < 2) { setFamilyHits([]); setPatientHits([]); return; }
    const url = kind === "family" ? `/api/families?q=${encodeURIComponent(term)}` : `/api/patients?q=${encodeURIComponent(term)}`;
    const response = await fetch(url, { cache: "no-store" }).catch(() => null);
    if (!response?.ok) return;
    const payload = await response.json().catch(() => null);
    if (kind === "family") setFamilyHits((payload?.families ?? []) as FamilyHit[]);
    else setPatientHits(Array.isArray(payload) ? payload as PatientHit[] : []);
  };

  const family = data?.family ?? null;
  const canEdit = data?.canEdit === true;

  const openGuarantor = () => {
    if (!family) return;
    setGuarantorKind(family.guarantor.kind);
    setGuarantorPatient(family.guarantor.patientId);
    setGuarantorName(family.guarantor.kind === "external" ? family.guarantor.name ?? "" : "");
    setGuarantorPhone(family.guarantor.kind === "external" ? family.guarantor.phone ?? "" : "");
    setMode("guarantor");
  };

  const guarantorText = (view: FamilyView) => {
    const g = view.guarantor;
    if (g.kind === "none") return "لا ضامن محدد";
    if (g.hidden) return "ضامنٌ من مرضى آخرين";
    if (g.kind === "patient") return `${g.name ?? ""}${g.patientNumber ? ` (#${g.patientNumber})` : ""}`;
    return `${g.name ?? ""}${g.phone ? ` — ${g.phone}` : ""} (من خارج المرضى)`;
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs" aria-label="العائلة">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-black text-navy-900">👨‍👩‍👧 العائلة{family ? ` — ${family.name}` : ""}</h2>
        {family ? (
          <div className="flex flex-wrap gap-1.5">
            {family.canSeeMoney ? (
              <a href={`/print/family-statement/${family.id}`} target="_blank" rel="noopener"
                className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-bold text-navy-800 hover:bg-slate-50">🖨️ كشف العائلة</a>
            ) : null}
            {canEdit ? (
              <>
                <button type="button" disabled={busy} onClick={() => { setName(family.name); setMode(mode === "rename" ? "idle" : "rename"); }}
                  className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-bold text-slate-600 hover:bg-slate-50">تعديل الاسم</button>
                <button type="button" disabled={busy} onClick={() => (mode === "guarantor" ? setMode("idle") : openGuarantor())}
                  className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-bold text-slate-600 hover:bg-slate-50">الضامن</button>
                <button type="button" disabled={busy} onClick={() => { setRole(null); setMode(mode === "add" ? "idle" : "add"); }}
                  className="rounded-lg bg-navy-800 px-2 py-1 text-xs font-bold text-white">+ فرد</button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? <p role="alert" className="mb-3 rounded-xl bg-rose-50 p-2 text-xs font-bold text-rose-700">{error}</p> : null}
      {!data && !error ? <p className="text-xs text-slate-400">جارٍ التحميل…</p> : null}

      {data && !family ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">لا عائلة مربوطة بهذا الملف.</p>
          {canEdit ? (
            <>
              {suggestions.length > 0 && mode === "idle" ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-2 text-xs">
                  <p className="mb-1 font-bold text-amber-900">جوال المريض يطابق جوال فردٍ في:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((hit) => (
                      <button key={hit.id} type="button" disabled={busy}
                        onClick={() => { setFamilyHits([hit]); setQuery(hit.name); setRole(null); setMode("join"); }}
                        className="rounded-lg border border-amber-300 bg-white px-2 py-1 font-bold text-amber-900">
                        ربط بعائلة {hit.name} ({hit.memberCount})
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-1.5">
                <button type="button" disabled={busy} onClick={() => {
                  const last = patientName.trim().split(/\s+/).at(-1) ?? "";
                  setName(last ? `عائلة ${last}` : ""); setRole(null); setMode(mode === "create" ? "idle" : "create");
                }} className="rounded-lg bg-navy-800 px-3 py-1.5 text-xs font-bold text-white">إنشاء عائلة</button>
                <button type="button" disabled={busy} onClick={() => { setRole(null); setQuery(""); setFamilyHits([]); setMode(mode === "join" ? "idle" : "join"); }}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-navy-800">ربط بعائلة قائمة</button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {mode === "create" && canEdit ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-xl bg-slate-50 p-2">
          <input value={name} onChange={(event) => setName(event.target.value)} aria-label="اسم العائلة" placeholder="عائلة الحكيمي"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs" />
          <RoleSelect label="صلة المريض" value={role} onChange={setRole} disabled={busy} />
          <button type="button" disabled={busy || !name.trim()}
            onClick={() => void run(() => send("/api/families", "POST", { name, members: [{ patientId, role }] }))}
            className="rounded-lg bg-brand-orange px-3 py-1 text-xs font-bold text-white disabled:opacity-50">حفظ</button>
        </div>
      ) : null}

      {mode === "join" && canEdit && !family ? (
        <div className="mt-2 space-y-1.5 rounded-xl bg-slate-50 p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <input value={query} onChange={(event) => void search(event.target.value, "family")} aria-label="ابحث عن عائلة"
              placeholder="اسم العائلة أو اسم/جوال أحد أفرادها" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs" />
            <RoleSelect label="صلة المريض" value={role} onChange={setRole} disabled={busy} />
          </div>
          {familyHits.map((hit) => (
            <button key={hit.id} type="button" disabled={busy}
              onClick={() => void run(() => send(`/api/families/${hit.id}/members`, "POST", { patientId, role }))}
              className="block w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-right text-xs font-bold text-navy-900 hover:bg-slate-100">
              ربط بعائلة {hit.name} <span className="text-slate-400">({hit.memberCount} أفراد)</span>
            </button>
          ))}
        </div>
      ) : null}

      {family ? (
        <>
          {mode === "rename" && canEdit ? (
            <div className="mb-2 flex gap-1.5 rounded-xl bg-slate-50 p-2">
              <input value={name} onChange={(event) => setName(event.target.value)} aria-label="اسم العائلة"
                className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs" />
              <button type="button" disabled={busy || !name.trim()}
                onClick={() => void run(() => send(`/api/families/${family.id}`, "PATCH", { name }))}
                className="rounded-lg bg-brand-orange px-3 py-1 text-xs font-bold text-white disabled:opacity-50">حفظ</button>
            </div>
          ) : null}

          <p className="mb-2 text-xs text-slate-600">
            <span className="font-bold">الضامن:</span> {guarantorText(family)}
            <span className="mr-1 text-[11px] text-slate-400">— معلومةٌ وكشف؛ حساب كل فردٍ مستقل.</span>
          </p>

          {mode === "guarantor" && canEdit ? (
            <div className="mb-2 space-y-1.5 rounded-xl bg-slate-50 p-2 text-xs">
              <div className="flex flex-wrap gap-3">
                {(["none", "patient", "external"] as const).map((kind) => (
                  <label key={kind} className="flex items-center gap-1 font-bold">
                    <input type="radio" name={`guarantor-${family.id}`} checked={guarantorKind === kind} onChange={() => setGuarantorKind(kind)} />
                    {kind === "none" ? "بلا ضامن" : kind === "patient" ? "فردٌ من العائلة" : "من خارج المرضى"}
                  </label>
                ))}
              </div>
              {guarantorKind === "patient" ? (
                <select aria-label="الضامن من الأفراد" value={guarantorPatient ?? ""}
                  onChange={(event) => setGuarantorPatient(event.target.value ? Number(event.target.value) : null)}
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1">
                  <option value="">اختر الفرد…</option>
                  {family.members.map((member) => <option key={member.id} value={member.id}>{member.fullName}</option>)}
                </select>
              ) : null}
              {guarantorKind === "external" ? (
                <div className="flex flex-wrap gap-1.5">
                  <input value={guarantorName} onChange={(event) => setGuarantorName(event.target.value)} aria-label="اسم الضامن"
                    placeholder="اسم الضامن" className="rounded-lg border border-slate-300 px-2 py-1" />
                  <input value={guarantorPhone} onChange={(event) => setGuarantorPhone(event.target.value)} aria-label="جوال الضامن"
                    placeholder="الجوال" dir="ltr" inputMode="tel" className="w-32 rounded-lg border border-slate-300 px-2 py-1" />
                </div>
              ) : null}
              <button type="button" disabled={busy || (guarantorKind === "patient" && !guarantorPatient)}
                onClick={() => void run(() => send(`/api/families/${family.id}/guarantor`, "PUT", {
                  guarantor: guarantorKind === "none" ? { kind: "none" }
                    : guarantorKind === "patient" ? { kind: "patient", patientId: guarantorPatient }
                      : { kind: "external", name: guarantorName, phone: guarantorPhone },
                }))}
                className="rounded-lg bg-brand-orange px-3 py-1 font-bold text-white disabled:opacity-50">حفظ الضامن</button>
            </div>
          ) : null}

          {mode === "add" && canEdit ? (
            <div className="mb-2 space-y-1.5 rounded-xl bg-slate-50 p-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <input value={query} onChange={(event) => void search(event.target.value, "patient")} aria-label="ابحث عن مريض"
                  placeholder="اسم المريض أو رقمه أو جواله" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs" />
                <RoleSelect label="صلة الفرد" value={role} onChange={setRole} disabled={busy} />
              </div>
              {patientHits.filter((hit) => !family.members.some((member) => member.id === hit.id)).slice(0, 8).map((hit) => (
                <button key={hit.id} type="button" disabled={busy}
                  onClick={() => void run(() => send(`/api/families/${family.id}/members`, "POST", { patientId: hit.id, role }))}
                  className="block w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-right text-xs font-bold text-navy-900 hover:bg-slate-100">
                  {hit.fullName} <span className="text-slate-400 ltr-nums">#{hit.patientNumber}</span>
                </button>
              ))}
            </div>
          ) : null}

          <ul className="divide-y divide-slate-100">
            {family.members.map((member) => (
              <li key={member.id} className="flex flex-wrap items-center gap-2 py-1.5 text-xs">
                <Link href={`/patients/${member.id}`} className={`font-bold ${member.id === patientId ? "text-slate-500" : "text-brand-blue hover:underline"}`}>
                  {member.fullName}
                </Link>
                {canEdit ? (
                  <RoleSelect label={`صلة ${member.fullName}`} value={member.role} disabled={busy}
                    onChange={(next) => void run(() => send(`/api/families/${family.id}/members`, "POST", { patientId: member.id, role: next }))} />
                ) : (
                  <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-bold text-slate-600">{member.roleLabel}</span>
                )}
                {member.balances ? (
                  <span className="flex flex-wrap gap-1">
                    {member.balances.length === 0 ? <span className="text-slate-400">مسدّد</span> : member.balances.map((line) => (
                      <span key={line.currency} className={`rounded-md px-1.5 py-0.5 font-bold ${line.balanceMinor > 0 ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>
                        {balanceLabel(line.balanceMinor, line.currency)}
                      </span>
                    ))}
                  </span>
                ) : null}
                {canEdit ? (
                  <button type="button" disabled={busy} aria-label={`فكّ ${member.fullName} من العائلة`}
                    onClick={() => {
                      if (window.confirm(`فكّ ${member.fullName} من ${family.name}؟ حسابه لا يتغيّر.`)) {
                        void run(() => send(`/api/families/${family.id}/members/${member.id}`, "DELETE"));
                      }
                    }}
                    className="mr-auto rounded-md px-1.5 py-0.5 text-[11px] font-bold text-slate-400 hover:bg-rose-50 hover:text-rose-700">فكّ</button>
                ) : null}
              </li>
            ))}
          </ul>

          {family.totals && family.totals.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2 text-xs">
              <span className="font-black text-navy-900">مجموع العائلة:</span>
              {family.totals.map((line) => (
                <span key={line.currency} className="rounded-md bg-slate-100 px-1.5 py-0.5 font-bold text-navy-900">
                  {CURRENCY_LABEL[line.currency]}: {line.balanceMinor === 0 ? "مسدّد" : balanceLabel(line.balanceMinor, line.currency)}
                </span>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
