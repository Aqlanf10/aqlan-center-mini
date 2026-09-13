"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnnouncementsManager } from "@/components/AnnouncementsManager";
import { InstallApp } from "@/components/InstallApp";
import { PageHeader } from "@/components/PageHeader";
import {
  CATEGORY_LABEL,
  definitionsInCategory,
  searchDefinitions,
  visibleCategories,
  type SettingCategory,
  type SettingDefinition,
} from "@/lib/settings-definitions";
import { canManageCategory, roleCan } from "@/lib/settings-permissions";
import {
  formatSettingValue,
  isDefaultSettingValue,
  optionLabel,
  settingControlKind,
} from "@/lib/settings-ui";
import { validateSettingSet, validateTypedSetting } from "@/lib/settings-validate";

interface SettingsSnapshot {
  values: Record<string, string>;
  versions: Record<string, string | null>;
  secrets: Record<string, boolean>;
}

interface MePayload { role?: string | null; displayName?: string | null; }

type EditMode = "edit" | "reset";

interface EditorState {
  definition: SettingDefinition;
  mode: EditMode;
  draft: string;
  reason: string;
  conflict: null | { attempted: string; current: string };
}

const CATEGORY_HELP: Partial<Record<SettingCategory, string>> = {
  general: "هوية المركز والبيانات التي تظهر في التقارير والسندات.",
  hours: "أوقات العمل التي تعتمد عليها الشاشات التشغيلية.",
  scheduling: "قواعد الحجز والمدد المرتبطة بالتشغيل الحالي.",
  capacity: "موارد المركز المستخدمة فعليًا اليوم.",
  patient_workflow: "قواعد متابعة المريض بعد الزيارة والمواعيد المتأخرة.",
  clinical: "حدود الملفات والتنبيهات ذات الصلة بالسجل السريري والمخزون.",
  finance: "سياسات مالية حساسة؛ بعضها يتطلب سببًا موثقًا عند التغيير.",
  reception: "الانتظار وشاشة الصالة والضبط اليومي للاستقبال.",
  staff: "سياسات الرؤية والصلاحيات التي يفرضها الخادم.",
  branding: "النصوص والهوية الظاهرة للمريض.",
  backup: "سياسة النسخ الاحتياطي؛ لا تُكشف أسرار أو مفاتيح تشفير هنا.",
};

const SPECIALIZED_LINKS = [
  ["/settings/users", "المستخدمون والصلاحيات"],
  ["/settings/service-materials", "ربط الخدمات بالمواد"],
  ["/settings/finance-expenses", "بنود وميزانيات المصروفات"],
  ["/settings/material-rates", "نسب إهلاك المواد"],
  ["/settings/laboratories", "المختبرات"],
  ["/settings/lab-services", "دليل خدمات المختبر"],
  ["/settings/lab-pricing", "تسعير المختبر"],
  ["/settings/export", "النسخ والتصدير"],
  ["/settings/ai", "الذكاء الاصطناعي"],
] as const;

function parseSettingsPayload(payload: Record<string, unknown>): SettingsSnapshot {
  const values: Record<string, string> = {};
  for (const definition of searchDefinitions("")) {
    const value = payload[definition.key];
    if (typeof value === "string") values[definition.key] = value;
  }
  const versions = payload.__versions && typeof payload.__versions === "object"
    ? payload.__versions as Record<string, string | null>
    : {};
  const secrets = payload.__secrets && typeof payload.__secrets === "object"
    ? payload.__secrets as Record<string, boolean>
    : {};
  return { values, versions, secrets };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

function SettingInput({ definition, value, onChange }: {
  definition: SettingDefinition;
  value: string;
  onChange: (value: string) => void;
}) {
  const kind = settingControlKind(definition);
  const common = "mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-blue focus:ring-2 focus:ring-brand-blue/10";

  if (definition.sensitivity === "secret") {
    return <input aria-label={definition.label} type="password" autoComplete="new-password" value={value}
      onChange={(event) => onChange(event.target.value)} className={common} placeholder="أدخل قيمة جديدة — القيمة الحالية لا يمكن إظهارها" />;
  }
  if (kind === "toggle") {
    return (
      <div className="mt-2 grid grid-cols-2 gap-2" role="group" aria-label={definition.label}>
        {["true", "false"].map((item) => (
          <button key={item} type="button" onClick={() => onChange(item)}
            aria-pressed={value === item}
            className={`rounded-xl border px-3 py-2 text-sm font-bold transition ${value === item ? "border-brand-blue bg-brand-blue/10 text-brand-blue" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
            {item === "true" ? "مفعّل" : "متوقف"}
          </button>
        ))}
      </div>
    );
  }
  if (kind === "select") {
    return (
      <select aria-label={definition.label} value={value} onChange={(event) => onChange(event.target.value)} className={common}>
        {(definition.options ?? []).map((option) => <option key={option} value={option}>{optionLabel(option)}</option>)}
      </select>
    );
  }
  if (kind === "textarea") {
    return <textarea aria-label={definition.label} value={value} onChange={(event) => onChange(event.target.value)}
      rows={5} className={common} />;
  }
  const inputType = kind === "number" ? "number" : kind === "time" ? "time" : kind === "date" ? "date" : "text";
  return (
    <input aria-label={definition.label} type={inputType} value={value} onChange={(event) => onChange(event.target.value)}
      min={kind === "number" ? definition.min : undefined} max={kind === "number" ? definition.max : undefined}
      step={definition.type === "DECIMAL" ? "any" : kind === "number" ? "1" : undefined} className={common} />
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const categories = useMemo(() => visibleCategories(), []);
  const [selectedCategory, setSelectedCategory] = useState<SettingCategory>(categories[0] ?? "general");
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>({ values: {}, versions: {}, secrets: {} });
  const [role, setRole] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const fetchSnapshot = useCallback(async (): Promise<SettingsSnapshot> => {
    const response = await fetch("/api/settings", { cache: "no-store" });
    const payload = await readJson(response);
    if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : "تعذّر تحميل الإعدادات.");
    return parseSettingsPayload(payload);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSnapshot, meResponse] = await Promise.all([
        fetchSnapshot(),
        fetch("/api/auth/me", { cache: "no-store" }),
      ]);
      const me = await readJson(meResponse) as MePayload;
      if (!meResponse.ok) throw new Error("تعذّر التحقق من صلاحيات المستخدم.");
      setSnapshot(nextSnapshot);
      setRole(typeof me.role === "string" ? me.role : null);
      setDisplayName(typeof me.displayName === "string" ? me.displayName : null);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر تحميل الإعدادات.");
    } finally {
      setLoading(false);
    }
  }, [fetchSnapshot]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!editor) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) setEditor(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor, saving]);

  const searchResults = useMemo(() => {
    if (!query.trim()) return definitionsInCategory(selectedCategory);
    const visible = new Set(categories);
    return searchDefinitions(query).filter((definition) => visible.has(definition.category));
  }, [categories, query, selectedCategory]);

  const openEditor = (definition: SettingDefinition, mode: EditMode) => {
    const current = snapshot.values[definition.key] ?? definition.defaultValue;
    setEditor({
      definition,
      mode,
      draft: definition.sensitivity === "secret" ? "" : mode === "reset" ? definition.defaultValue : current,
      reason: "",
      conflict: null,
    });
    setError(null);
    setSuccess(null);
  };

  const editorProblem = useMemo(() => {
    if (!editor || editor.mode === "reset") return null;
    const typed = validateTypedSetting(editor.definition.key, editor.draft);
    if (typed) return typed;
    return validateSettingSet({ [editor.definition.key]: editor.draft }, snapshot.values);
  }, [editor, snapshot.values]);

  const submitEditor = useCallback(async () => {
    if (!editor || saving) return;
    if (editor.definition.requiresReason && !editor.reason.trim()) {
      setError("هذا التغيير حساس ويحتاج سببًا واضحًا قبل الحفظ.");
      return;
    }
    if (editor.mode === "edit" && editorProblem) {
      setError(editorProblem);
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);
    const key = editor.definition.key;
    const attempted = editor.mode === "reset" ? editor.definition.defaultValue : editor.draft;
    try {
      const body = editor.mode === "reset"
        ? { action: "reset", keys: [key], __versions: { [key]: snapshot.versions[key] ?? null }, reason: editor.reason.trim() || null }
        : { [key]: editor.draft, __versions: { [key]: snapshot.versions[key] ?? null }, __reason: editor.reason.trim() || null };
      const response = await fetch("/api/settings", {
        method: editor.mode === "reset" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);
      if (response.status === 409) {
        const latest = await fetchSnapshot();
        setSnapshot(latest);
        setEditor((current) => current ? {
          ...current,
          conflict: { attempted, current: latest.values[key] ?? current.definition.defaultValue },
        } : current);
        setError("تغيّر هذا الإعداد بعد فتحه. راجع القيمة الحالية قبل اتخاذ قرار جديد.");
        return;
      }
      if (!response.ok) {
        setError(typeof payload.message === "string" ? payload.message : "تعذّر حفظ الإعداد.");
        return;
      }
      const latest = await fetchSnapshot();
      setSnapshot(latest);
      setEditor(null);
      setSuccess(editor.mode === "reset" ? "أُعيد الإعداد إلى قيمته الافتراضية وسُجّل الحدث." : "حُفظ الإعداد وسُجّل التغيير.");
      router.refresh();
    } catch {
      setError("تعذّر الاتصال بالخادم. بقي تعديلك في النافذة ولم يُعتبر محفوظًا.");
    } finally {
      setSaving(false);
    }
  }, [editor, editorProblem, fetchSnapshot, router, saving, snapshot.versions]);

  const canViewHistory = roleCan(role, "settings.view_history");

  const headerLinks = [
    { href: "/settings", label: "الإعدادات المركزية", current: true },
    ...(canViewHistory ? [{ href: "/settings/history", label: "سجل تغييرات الإعدادات" }] : []),
    { href: "/settings/users", label: "المستخدمون والصلاحيات" },
    { href: "/settings/audit", label: "سجل التدقيق العام" },
  ];

  return (
    <main className="mx-auto max-w-7xl p-4 pb-16" dir="rtl">
      <PageHeader title="الإعدادات المركزية" subtitle="سياسات المركز الفعلية من مصدر واحد — بلا مفاتيح صورية ولا تعديل مباشر للقاعدة" links={headerLinks} />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
        <div>
          <p className="text-sm font-black text-navy-950">{displayName ? `مرحبًا ${displayName}` : "إدارة إعدادات المركز"}</p>
          <p className="mt-1 text-xs text-slate-500">{role && canManageCategory(role, "general") ? "يمكنك تعديل الفئات المصرح بها. التغييرات الحساسة تُسجّل مع سببها." : "عرض للقراءة فقط حسب صلاحيات حسابك."}</p>
        </div>
        <div className="flex items-center gap-2">
          {canViewHistory ? <Link href="/settings/history" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50">سجل التغييرات</Link> : null}
          <button type="button" onClick={() => void load()} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50">تحديث</button>
        </div>
      </div>

      {error ? <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div> : null}
      {success ? <div role="status" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{success}</div> : null}

      {loading ? (
        <section aria-busy="true" className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">جارٍ تحميل الإعدادات…</section>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="h-fit rounded-2xl border border-slate-200 bg-white p-3 lg:sticky lg:top-4">
            <label htmlFor="settings-search" className="text-xs font-bold text-slate-700">بحث في الإعدادات</label>
            <input id="settings-search" value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder="ابحث بالاسم أو الوصف…" className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-blue focus:ring-2 focus:ring-brand-blue/10" />
            {query ? <button type="button" onClick={() => setQuery("")} className="mt-2 text-xs font-bold text-brand-blue">مسح البحث</button> : null}

            <nav aria-label="فئات الإعدادات" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-1">
              {categories.map((category) => {
                const active = !query && selectedCategory === category;
                return (
                  <button key={category} type="button" onClick={() => { setSelectedCategory(category); setQuery(""); }}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-right text-xs font-bold transition ${active ? "bg-navy-950 text-white" : "bg-slate-50 text-slate-700 hover:bg-slate-100"}`}>
                    <span>{CATEGORY_LABEL[category]}</span>
                    <span className={active ? "text-white/70" : "text-slate-400"}>{definitionsInCategory(category).length}</span>
                  </button>
                );
              })}
            </nav>
          </aside>

          <section className="min-w-0">
            <div className="mb-3 rounded-2xl border border-slate-200 bg-white p-4">
              <h1 className="text-lg font-black text-navy-950">{query ? `نتائج البحث عن «${query}»` : CATEGORY_LABEL[selectedCategory]}</h1>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">{query ? `${searchResults.length} إعدادًا مطابقًا من الفئات الظاهرة.` : CATEGORY_HELP[selectedCategory] ?? "إعدادات مستخدمة فعليًا في النظام الحالي."}</p>
            </div>

            {searchResults.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">لا توجد إعدادات مطابقة. لا نعرض فئات أو مفاتيح بلا مستهلك فعلي.</div>
            ) : (
              <div className="grid gap-3 xl:grid-cols-2">
                {searchResults.map((definition) => {
                  const value = snapshot.values[definition.key] ?? definition.defaultValue;
                  const editable = Boolean(role && canManageCategory(role, definition.category) && !definition.systemLocked);
                  const isDefault = definition.sensitivity === "secret" ? false : isDefaultSettingValue(definition, value);
                  return (
                    <article key={definition.key} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-sm font-black text-navy-950">{definition.label}</h2>
                            {definition.systemLocked ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">محكوم بالنظام</span>
                              : definition.sensitivity !== "secret" ? <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${isDefault ? "bg-slate-100 text-slate-600" : "bg-blue-50 text-blue-700"}`}>{isDefault ? "افتراضي" : "مخصّص"}</span> : null}
                            {!editable && !definition.systemLocked ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-800">للقراءة فقط</span> : null}
                          </div>
                          {definition.description ? <p className="mt-1 text-xs leading-relaxed text-slate-500">{definition.description}</p> : null}
                        </div>
                        <div className="shrink-0 text-left">
                          <p className="text-base font-black text-navy-950">{formatSettingValue(definition, value, snapshot.secrets[definition.key] ?? false)}</p>
                          {definition.sensitivity !== "secret" && definition.unit ? <span className="sr-only">{definition.unit}</span> : null}
                        </div>
                      </div>

                      {definition.help ? <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">{definition.help}</p> : null}
                      {definition.impact ? <p className="mt-3 rounded-xl border border-amber-100 bg-amber-50/70 px-3 py-2 text-[11px] leading-relaxed text-amber-900"><strong>الأثر:</strong> {definition.impact}</p> : null}

                      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
                        <span className="text-[10px] text-slate-400" title={definition.key}>{CATEGORY_LABEL[definition.category]} · {definition.scope === "system" ? "النظام" : "المركز"}</span>
                        {editable ? (
                          <div className="flex items-center gap-2">
                            {definition.sensitivity !== "secret" && !isDefault ? <button type="button" onClick={() => openEditor(definition, "reset")} className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50">إعادة الافتراضي</button> : null}
                            <button type="button" onClick={() => openEditor(definition, "edit")} className="rounded-lg bg-navy-950 px-3 py-1.5 text-xs font-bold text-white hover:bg-navy-800">{definition.sensitivity === "secret" ? (snapshot.secrets[definition.key] ? "استبدال" : "تهيئة") : "تعديل"}</button>
                          </div>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            {!query && selectedCategory === "reception" ? (
              <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
                <h2 className="mb-2 text-sm font-black text-navy-950">إعلانات شاشة الصالة</h2>
                <p className="mb-3 text-xs text-slate-500">الإعلانات سجلات مستقلة؛ الحقل النصّي القديم مقفل للقراءة حفاظًا على التوافق.</p>
                <AnnouncementsManager />
              </div>
            ) : null}

            {!query && selectedCategory === "general" ? (
              <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div><h2 className="text-sm font-black text-navy-950">تثبيت النظام كتطبيق</h2><p className="mt-1 text-xs text-slate-500">تثبيت اختصار مستقل لسطح المكتب أو شاشة الهاتف.</p></div>
                  <InstallApp />
                </div>
              </div>
            ) : null}
          </section>
        </div>
      )}

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-black text-navy-950">إدارات متخصصة</h2>
        <p className="mt-1 text-xs text-slate-500">هذه وحدات مستقلة وليست مفاتيح عامة؛ بقيت في شاشاتها المتخصصة بدل تحويل الإعدادات إلى محرر قاعدة بيانات.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {SPECIALIZED_LINKS.map(([href, label]) => <Link key={href} href={href} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100">{label}</Link>)}
        </div>
      </section>

      {editor ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setEditor(null); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="setting-dialog-title" className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-bold text-slate-400">{CATEGORY_LABEL[editor.definition.category]}</p>
                <h2 id="setting-dialog-title" className="mt-1 text-lg font-black text-navy-950">{editor.mode === "reset" ? `إعادة «${editor.definition.label}»` : editor.definition.label}</h2>
              </div>
              <button type="button" aria-label="إغلاق" disabled={saving} onClick={() => setEditor(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600">×</button>
            </div>

            {editor.mode === "reset" ? (
              <div className="mt-4 rounded-xl bg-slate-50 p-3 text-sm">
                <p><span className="text-slate-500">القيمة الحالية:</span> <strong>{formatSettingValue(editor.definition, snapshot.values[editor.definition.key], snapshot.secrets[editor.definition.key])}</strong></p>
                <p className="mt-1"><span className="text-slate-500">بعد الإعادة:</span> <strong>{formatSettingValue(editor.definition, editor.definition.defaultValue)}</strong></p>
              </div>
            ) : (
              <div className="mt-4">
                <label className="text-xs font-bold text-slate-700">القيمة الجديدة</label>
                <SettingInput definition={editor.definition} value={editor.draft} onChange={(draft) => setEditor((current) => current ? { ...current, draft, conflict: null } : current)} />
                {editor.definition.unit ? <p className="mt-1 text-[11px] text-slate-400">الوحدة: {editor.definition.unit}</p> : null}
                {editorProblem ? <p role="alert" className="mt-2 text-xs font-bold text-red-700">{editorProblem}</p> : null}
              </div>
            )}

            {editor.definition.impact ? <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900"><strong>قبل التأكيد:</strong> {editor.definition.impact}</div> : null}

            <div className="mt-4">
              <label htmlFor="setting-change-reason" className="text-xs font-bold text-slate-700">سبب التغيير {editor.definition.requiresReason ? <span className="text-red-600">(مطلوب)</span> : <span className="text-slate-400">(اختياري)</span>}</label>
              <textarea id="setting-change-reason" rows={2} value={editor.reason} onChange={(event) => setEditor((current) => current ? { ...current, reason: event.target.value } : current)} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-blue" placeholder="لماذا نغيّر هذه السياسة؟" />
            </div>

            {editor.conflict ? (
              <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-900">
                <p className="font-black">تعارض تعديل — لم نكتب فوق التغيير الأحدث.</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2"><p>محاولتك: <strong>{editor.conflict.attempted}</strong></p><p>القيمة الحالية: <strong>{editor.conflict.current}</strong></p></div>
                <div className="mt-3 flex gap-2"><button type="button" onClick={() => setEditor((current) => current ? { ...current, draft: current.conflict?.current ?? current.draft, conflict: null } : current)} className="rounded-lg border border-red-300 bg-white px-2.5 py-1.5 font-bold">تحميل القيمة الحالية</button><button type="button" onClick={() => setEditor(null)} className="rounded-lg px-2.5 py-1.5 font-bold text-red-800">إلغاء تعديلي</button></div>
              </div>
            ) : null}

            <div className="mt-5 flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
              <button type="button" disabled={saving} onClick={() => setEditor(null)} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700">إلغاء</button>
              <button type="button" disabled={saving || (editor.mode === "edit" && Boolean(editorProblem)) || (editor.definition.requiresReason && !editor.reason.trim())}
                onClick={() => void submitEditor()} className="rounded-xl bg-navy-950 px-4 py-2 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50">
                {saving ? "جارٍ الحفظ…" : editor.mode === "reset" ? "تأكيد الإعادة" : "حفظ التغيير"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
