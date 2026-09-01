"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ALL_SETTING_KEYS,
  GROUP_LABEL,
  SETTING_FIELDS,
  validateSetting,
  type SettingKey,
  type SettingsMap,
} from "@/lib/settings";
import { PageHeader } from "@/components/PageHeader";
import { InstallApp } from "@/components/InstallApp";
import { AnnouncementsManager } from "@/components/AnnouncementsManager";

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
  // فيضيع الفرق بين «ضبطه المدير» و«بقي على الافتراضي». الحساب على كل المفاتيح
  // لا على حقول النموذج فقط: لشاشة الصالة مفاتيحها الخاصة بقسمها في الأسفل.
  const changed = useMemo(() => {
    const diff: Partial<Record<SettingKey, string>> = {};
    for (const key of ALL_SETTING_KEYS) {
      const next = values[key];
      if (next !== undefined && next !== initial[key]) diff[key] = next;
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
          { href: "/settings/service-materials", label: "ربط الخدمات بالمواد" },
          { href: "/settings/audit", label: "سجل التدقيق" },
          { href: "/settings/export", label: "النسخ والتصدير" },
          { href: "/settings/ai", label: "الذكاء الاصطناعي" },
        ]}
      />

      {/* التثبيت: النظام نفسه كتطبيق سطح مكتب/جوال — نفس الـ API ونفس القاعدة. */}
      <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-black text-navy-900">تثبيت النظام كتطبيق</h2>
            <p className="mt-1 text-xs text-slate-500">
              سطح المكتب بلا شريط روابط، وجوال الطاقم بأيقونة على الشاشة الرئيسية.
              إن لم يظهر الزر فالتثبيت متاح من قائمة المتصفح نفسها («تثبيت» أو «إضافة إلى الشاشة الرئيسية»).
            </p>
          </div>
          <InstallApp />
        </div>
      </section>

      {/*
        * المالية المخفية وصلاحيات الأطباء (من عمل الوكيل المساعد): بوابةٌ واحدة
        * لما يُفتح ويُغلق على كل طبيب — الرؤية والتحرير والمال، مع مستحقاته الشخصية
        * كبابٍ وحيدٍ افتراضي. الإدارة من شاشة المستخدمين للمدير وحده.
        */}
      <section className="mb-4 rounded-2xl border-2 border-amber-200 bg-gradient-to-l from-amber-50/70 to-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm">🛡️</span>
              <h2 className="text-sm font-black text-amber-950">المالية المخفية وصلاحيات الأطباء</h2>
            </div>
            <p className="mt-1 text-xs text-amber-900/80">
              افتراضيًا: إيرادات المركز وأسعار التكلفة والمصروفات والأرباح العامة مخفية تماماً عن الأطباء، مع إتاحة مستحقاتهم الشخصية فقط.
            </p>
          </div>
          <a
            href="/settings/users"
            className="rounded-xl border border-amber-300 bg-white px-3.5 py-2 text-xs font-black text-amber-950 shadow-xs hover:bg-amber-50"
          >
            إدارة صلاحيات ونِسَب الأطباء ‹
          </a>
        </div>
      </section>

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

          {/* شاشة الصالة — قسمها الخاص لا مجموعة الحقول العامة: مفاتيحه أزرار
              تشغيل/إيقاف وقوائم اختيار يفهمها غير المبرمج، لا حقول true/false.
              الإعلانات قائمةٌ حيّة مستقلة: لكل إعلانٍ سجلّه وحفظه وحذفه — لا
              تمرّ عبر شريط حفظ الإعدادات العام ولا عبر خانةٍ واحدة طولها
              أربعمئة حرف. */}
          <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="mb-1 text-sm font-bold">شاشة الصالة (التلفاز)</h2>
            <p className="mb-3 text-[11px] text-slate-500">
              تتحكم في ما يراه المرضى على تلفاز الانتظار — /display من قائمة «اليوم».
            </p>
            <div className="space-y-3">
              <div>
                <span className="mb-1 block text-[11px] font-bold text-slate-500">طريقة عرض الأسماء</span>
                <div className="flex gap-1.5">
                  {[
                    { value: "first_initial", label: "أحمد م. — الاسم الأول وحرف العائلة" },
                    { value: "first_only", label: "أحمد — الاسم الأول فقط" },
                  ].map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setValues((current) => ({ ...current, "display.privacy_mode": option.value }))}
                      className={`rounded-xl border px-3 py-2 text-xs font-bold ${
                        (values["display.privacy_mode"] ?? "first_initial") === option.value
                          ? "border-brand-blue bg-brand-blue text-white"
                          : "border-slate-200 bg-white text-slate-600"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setValues((current) => ({
                  ...current,
                  "display.voice": current["display.voice"] === "false" ? "true" : "false",
                }))}
                className={`rounded-xl border px-3 py-2 text-xs font-bold ${
                  values["display.voice"] === "false"
                    ? "border-slate-200 bg-white text-slate-500"
                    : "border-emerald-300 bg-emerald-50 text-emerald-700"
                }`}
              >
                نطق الاسم عند النداء: {values["display.voice"] === "false" ? "متوقف" : "مفعّل"}
              </button>
              <button
                type="button"
                onClick={() => setValues((current) => ({
                  ...current,
                  "display.show_ortho": current["display.show_ortho"] === "false" ? "true" : "false",
                }))}
                className={`rounded-xl border px-3 py-2 text-xs font-bold ${
                  values["display.show_ortho"] === "false"
                    ? "border-slate-200 bg-white text-slate-500"
                    : "border-emerald-300 bg-emerald-50 text-emerald-700"
                }`}
              >
                بطاقة جلسات التقويم: {values["display.show_ortho"] === "false" ? "مخفية" : "ظاهرة"}
              </button>
            </div>
            <label className="mt-3 block">
              <span className="mb-1 block text-[11px] font-bold text-slate-500">الشعار الثابت أسفل الشاشة</span>
              <input
                type="text"
                value={values["display.tagline"] ?? ""}
                onChange={(event) => setValues((current) => ({ ...current, "display.tagline": event.target.value }))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue"
                dir="rtl"
              />
            </label>
            <div className="mt-4">
              <AnnouncementsManager />
            </div>
          </section>

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
