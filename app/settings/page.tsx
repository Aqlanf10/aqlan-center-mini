"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GROUP_LABEL,
  SETTING_FIELDS,
  validateSetting,
  type SettingKey,
  type SettingsMap,
} from "@/lib/settings";
import { PageHeader } from "@/components/PageHeader";

/**
 * شاشة الإعدادات.
 *
 * الشاشة التي تجعل البرنامج ملكًا لصاحبه: عدد الكراسي صار ثلاثة، سعر الصرف تغيّر
 * اليوم، اسم المركز يُطبع على السند — كلها تُضبط من هنا لا بنشرة برمجية. والفرق
 * بينهما في عيادة تعمل: دقيقة مقابل يوم.
 *
 * لا حفظ تلقائي: سعر صرف يُحفظ أثناء الكتابة — «53» قبل أن تكتمل «530» — يفسد كل
 * دفعة تُسجَّل في تلك اللحظة. الحفظ بضغطة واعية.
 */

const GROUPS = ["clinic", "finance", "operations"] as const;

export default function SettingsPage() {
  const [values, setValues] = useState<Partial<SettingsMap>>({});
  const [initial, setInitial] = useState<Partial<SettingsMap>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/settings", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setValues(payload as SettingsMap);
      setInitial(payload as SettingsMap);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // ما تغيّر وحده يُرسَل: إرسال الأربعة عشر حقلًا كلها يكتب قيمًا لم يلمسها أحد،
  // فيضيع الفرق بين «ضبطه المدير» و«بقي على الافتراضي».
  const changed = useMemo(() => {
    const diff: Partial<Record<SettingKey, string>> = {};
    for (const field of SETTING_FIELDS) {
      const next = values[field.key];
      if (next !== undefined && next !== initial[field.key]) diff[field.key] = next;
    }
    return diff;
  }, [values, initial]);

  const dirty = Object.keys(changed).length > 0;

  const localProblem = useMemo(() => {
    for (const [key, value] of Object.entries(changed) as [SettingKey, string][]) {
      const problem = validateSetting(key, value);
      if (problem) return problem;
    }
    return null;
  }, [changed]);

  const save = useCallback(async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changed),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر الحفظ.");
        return;
      }
      setValues(payload as SettingsMap);
      setInitial(payload as SettingsMap);
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      // إعادة تحميل الصفحة: اسم المركز وعدد الكراسي يُقرآن في التخطيط الجذري على
      // الخادم، فبلا إعادة تحميل تبقى بقية الشاشات على القيمة القديمة حتى التنقّل.
      setTimeout(() => window.location.reload(), 600);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setSaving(false);
    }
  }, [changed, dirty, saving]);

  return (
    <main className="mx-auto max-w-3xl p-4 pb-32">
      <PageHeader
        title="الإعدادات"
        subtitle="هوية المركز وأسعار الصرف وقواعد التشغيل"
        links={[
          { href: "/settings", label: "عام", current: true },
          { href: "/settings/users", label: "المستخدمون والصلاحيات" },
          { href: "/settings/audit", label: "سجل التدقيق" },
          { href: "/settings/export", label: "النسخ والتصدير" },
        ]}
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : (
        <>
          {GROUPS.map((group) => (
            <section key={group} className="mb-5 rounded-2xl border border-slate-200 bg-white p-4">
              <h2 className="mb-3 text-sm font-bold">{GROUP_LABEL[group]}</h2>
              {group === "finance" ? (
                <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
                  سعر الصرف يُستخدم للدفعات الجديدة فقط. كل دفعة سابقة تحتفظ بسعر يومها
                  ولا يتغيّر أثرها في التقارير حين تُحدّث السعر هنا.
                </p>
              ) : null}
              <div className="space-y-3">
                {SETTING_FIELDS.filter((field) => field.group === group).map((field) => {
                  const value = values[field.key] ?? "";
                  const problem = value !== initial[field.key] ? validateSetting(field.key, value) : null;
                  return (
                    <label key={field.key} className="block">
                      <span className="mb-1 block text-[11px] font-bold text-slate-500">{field.label}</span>
                      <input
                        type={field.kind === "time" ? "time" : field.kind === "date" ? "date" : field.kind === "number" ? "number" : "text"}
                        value={value}
                        onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                        className={`w-full rounded-xl border px-3 py-2 text-sm outline-none ${
                          problem ? "border-red-300 bg-red-50" : "border-slate-200 focus:border-brand-blue"
                        }`}
                        dir={field.kind === "text" ? "rtl" : "ltr"}
                      />
                      {problem ? (
                        <span className="mt-1 block text-[11px] font-bold text-red-600">{problem}</span>
                      ) : field.hint ? (
                        <span className="mt-1 block text-[11px] text-slate-400">{field.hint}</span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </section>
          ))}

          {/* شريط الحفظ ملتصق بأسفل الشاشة: النموذج أطول من الشاشة، وزرٌّ في آخره
              يعني أن يكتب المدير قيمة ثم يفقدها لأنه انتقل قبل أن يمرّر إليه. */}
          <div className="fixed inset-x-0 bottom-16 z-10 border-t border-slate-200 bg-white/95 p-3 backdrop-blur lg:bottom-0">
            <div className="mx-auto flex max-w-3xl items-center gap-3">
              <span className="flex-1 text-xs font-bold text-slate-500">
                {saved ? "حُفظت الإعدادات ✓"
                  : localProblem ? localProblem
                  : dirty ? `${Object.keys(changed).length} تغييرًا بانتظار الحفظ`
                  : "لا تغييرات"}
              </span>
              <button
                onClick={save}
                disabled={saving || !dirty || Boolean(localProblem)}
                className="rounded-xl bg-brand-orange px-6 py-2.5 text-sm font-extrabold text-white disabled:opacity-40"
              >
                {saving ? "جارٍ الحفظ…" : "حفظ"}
              </button>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
