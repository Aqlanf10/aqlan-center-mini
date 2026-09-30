"use client";

import { useEffect, useMemo, useState } from "react";
import { FAMILY_ROLES, FAMILY_ROLE_LABEL, type FamilyRole } from "@/lib/patient-families";

/**
 * (PAT-4) عند التسجيل: جوالٌ يطابق جوال فردٍ في عائلةٍ قائمة يقترح «ربط بعائلة …». اقتراحٌ لا ربط —
 * الربط لا يحدث إلا إن اختارته الاستقبال، وبعد حفظ الملف. من لا يربط العائلات (الطبيب) لا يرى شيئًا
 * (الخادم يرفض البحث له).
 */
export interface FamilyLinkChoice { familyId: number; name: string; role: FamilyRole | null }

interface Suggestion { familyId: number; name: string; memberCount: number; matchedBy: { fullName: string } }

export function FamilyLinkSuggestion({ phone, value, onChange }: {
  phone: string;
  value: FamilyLinkChoice | null;
  onChange: (choice: FamilyLinkChoice | null) => void;
}) {
  const [found, setFound] = useState<{ digits: string; list: Suggestion[] }>({ digits: "", list: [] });
  const digits = phone.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\D/g, "");
  /* نتيجةٌ لجوالٍ غير المكتوب الآن لا تُعرض. */
  const suggestions = useMemo(() => (found.digits === digits ? found.list : []), [found, digits]);

  useEffect(() => {
    if (digits.length < 7) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void fetch(`/api/families?phone=${encodeURIComponent(digits)}`, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : { suggestions: [] }))
        .then((payload: { suggestions?: Suggestion[] }) => { if (!cancelled) setFound({ digits, list: payload.suggestions ?? [] }); })
        .catch(() => undefined);
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [digits]);

  /* جوالٌ تغيّر فلم يعد يطابق العائلة المختارة: يسقط الاختيار — لا ربط بعائلةٍ لم تعد مقترحة. */
  useEffect(() => {
    if (value && !suggestions.some((s) => s.familyId === value.familyId)) onChange(null);
  }, [suggestions, value, onChange]);

  if (suggestions.length === 0) return null;
  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50 p-2 text-xs" aria-label="اقتراح ربط بعائلة">
      <p className="mb-1 font-bold text-sky-900">هذا الجوال مسجّلٌ لفردٍ في عائلة:</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {suggestions.map((s) => {
          const chosen = value?.familyId === s.familyId;
          return (
            <button key={s.familyId} type="button" aria-pressed={chosen}
              onClick={() => onChange(chosen ? null : { familyId: s.familyId, name: s.name, role: value?.role ?? null })}
              className={`rounded-lg border px-2 py-1 font-bold ${chosen ? "border-sky-600 bg-sky-600 text-white" : "border-sky-300 bg-white text-sky-900"}`}
              title={`يطابق جوال ${s.matchedBy.fullName}`}>
              {chosen ? "✓ " : ""}ربط بعائلة {s.name} ({s.memberCount})
            </button>
          );
        })}
        {value ? (
          <select aria-label="صلة المريض الجديد" value={value.role ?? ""}
            onChange={(event) => onChange({ ...value, role: (event.target.value || null) as FamilyRole | null })}
            className="rounded-lg border border-sky-300 bg-white px-2 py-1">
            <option value="">الصلة…</option>
            {FAMILY_ROLES.map((role) => <option key={role} value={role}>{FAMILY_ROLE_LABEL[role]}</option>)}
          </select>
        ) : null}
      </div>
    </div>
  );
}

/** بعد حفظ الملف الجديد: يربطه بالعائلة المختارة — رسالة تحذير عربية إن تعذّر (الملف محفوظ على كل حال). */
export async function linkNewPatientToFamily(patientId: number, choice: FamilyLinkChoice | null): Promise<string | null> {
  if (!choice) return null;
  try {
    const response = await fetch(`/api/families/${choice.familyId}/members`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId, role: choice.role }),
    });
    if (response.ok) return null;
    const payload = await response.json().catch(() => ({}));
    return `حُفظ الملف، لكن تعذّر ربطه بعائلة ${choice.name}: ${payload.message ?? "أعد المحاولة من ملف المريض."}`;
  } catch {
    return `حُفظ الملف، لكن تعذّر ربطه بعائلة ${choice.name}. اربطه من ملف المريض.`;
  }
}
