"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import {
  MAX_BUFFER,
  MAX_DURATION,
  MAX_PRIORITY,
  MIN_DURATION,
  MIN_PRIORITY,
  SPECIALTIES,
  SPECIALTY_LABEL,
  normalizeCode,
  searchServices,
  validateService,
  type AppointmentService,
  type AppointmentServiceInput,
  type ServiceSpecialty,
} from "@/lib/appointment-services";

/**
 * خدمات المواعيد — الشاشة التي يملك بها المالكُ كتالوجَ عمله.
 *
 * قبلها كانت أنواع الزيارة تسعةً مكتوبةً في الشيفرة بمدَدٍ ثابتة. فحين يبدأ المركز
 * عملًا جديدًا — «تركيب مسمار تقويم»، «تسليم متحرّك»، «مراجعة سريعة بعد الخلع» —
 * لا يجد له اسمًا، فيُحجز تحت «أخرى» بمدّةٍ لا تشبهه. والنتيجة ليست تسميةً خاطئة
 * فقط: محرّك السعة يحسب اليوم بمدَدٍ كاذبة، فيقول «فيه متّسع» ليومٍ ممتلئ، فتقع
 * الزحمة التي بُني النظام كلّه ليمنعها. وهذه الشاشة تنقل القرار من نشرةٍ برمجية
 * إلى المالك في اليوم نفسه.
 *
 * **ثلاثة أحكامٍ تحكم تصميمها:**
 *
 * ١) **المدّة والفواصل مدخلاتُ سعةٍ لا وصفٌ جميل.** من يرفع مدّة «متابعة تقويم»
 *    من عشر دقائق إلى خمس عشرة يُنقص طاقة المساء الثلاثين إلى عشرين. فالشاشة تقول
 *    هذا صراحةً عند الحقل، ولا تدَعُه يُكتشف بعد أسبوعٍ من الشكاوى.
 *
 * ٢) **الرمز هوية.** المواعيد المحجوزة والقواعد والتكاملات تشير إليه. فهو يُكتب
 *    مرّةً عند الإنشاء ويُعرض بعدها للقراءة فقط — والخادم يتجاهل أيّ رمزٍ يُرسَل مع
 *    التعديل. ومن أراد رمزًا آخر: يعطّل هذه وينشئ غيرها.
 *
 * ٣) **لا حذف.** خدمةٌ حُجزت بها مواعيد إن مُحيت صار تاريخ المركز يشير إلى لا شيء:
 *    موعدُ العام الماضي بلا اسم، وتقريرُ الأمس بسطرٍ فارغ. فالتعطيل يمنع الحجز
 *    الجديد ويُبقي القديم مقروءًا باسمه. ولذلك لا زرَّ محوٍ في هذه الشاشة أصلًا —
 *    غيابُه قرارٌ لا نسيان.
 *
 * وحقولها **مكتوبةُ النوع** لا مربّعَ JSON: المالك أخصائيُّ تقويم لا مبرمج، ونصٌّ
 * حرٌّ يُفسَّر لاحقًا هو أسرع طريقٍ إلى كتالوجٍ نصفه مكسور.
 */

/* ── الحالة القابلة للتحرير ───────────────────────────────────────────────── */

/**
 * نموذجُ الشاشة نصوصٌ لا أرقام — عمدًا.
 *
 * حقلٌ رقميّ فارغٌ في المتصفّح ليس صفرًا، ومربّعٌ فيه «١٢٫٥» ليس عددًا صحيحًا.
 * فلو حملت الحالةُ `number` لصار الفارغ `NaN` صامتًا أو صفرًا كاذبًا. النصّ يُحفظ
 * كما كُتب، ويُحوَّل مرّةً واحدة عند الحفظ، فيردّه `validateService` بالعربية إن
 * خالف — بدل أن يُصحَّح خلف ظهر من كتبه.
 */
export interface ServiceForm {
  code: string;
  nameAr: string;
  nameEn: string;
  specialty: ServiceSpecialty;
  defaultDurationMinutes: string;
  bufferBeforeMinutes: string;
  bufferAfterMinutes: string;
  priority: string;
  sortOrder: string;
  badgeClass: string;
  requiresProvider: boolean;
  requiresChair: boolean;
  allowsConcurrentProviderWork: boolean;
  consumesEmergencyReserve: boolean;
  isActive: boolean;
}

export type ActivityFilter = "all" | "active" | "inactive";

/** خدمةٌ جديدة تبدأ بما يشبه أغلب عمل المركز: طبيبٌ وكرسيٌّ وعشرون دقيقة. */
export function emptyForm(): ServiceForm {
  return {
    code: "",
    nameAr: "",
    nameEn: "",
    specialty: "general",
    defaultDurationMinutes: "20",
    bufferBeforeMinutes: "0",
    bufferAfterMinutes: "0",
    priority: "50",
    sortOrder: "100",
    badgeClass: "",
    requiresProvider: true,
    requiresChair: true,
    allowsConcurrentProviderWork: false,
    consumesEmergencyReserve: false,
    isActive: true,
  };
}

export function formFromService(service: AppointmentService): ServiceForm {
  return {
    code: service.code,
    nameAr: service.nameAr,
    nameEn: service.nameEn ?? "",
    specialty: service.specialty,
    defaultDurationMinutes: String(service.defaultDurationMinutes),
    bufferBeforeMinutes: String(service.bufferBeforeMinutes),
    bufferAfterMinutes: String(service.bufferAfterMinutes),
    priority: String(service.priority),
    sortOrder: String(service.sortOrder),
    badgeClass: service.badgeClass ?? "",
    requiresProvider: service.requiresProvider,
    requiresChair: service.requiresChair,
    allowsConcurrentProviderWork: service.allowsConcurrentProviderWork,
    consumesEmergencyReserve: service.consumesEmergencyReserve,
    isActive: service.isActive,
  };
}

/**
 * «١٢٫٥ دقيقة» ليست خطأً في الكتابة بل قيمةٌ لا يقبلها الجدول.
 *
 * فما ليس عددًا صحيحًا يصير `NaN` هنا عمدًا، ليردّه `validateService` برسالةٍ
 * عربيةٍ تقول الحدَّ المسموح — لا أن يُقرّب بصمتٍ إلى ثلاث عشرة فيُفاجأ صاحبه.
 */
function integerOf(raw: string): number {
  const trimmed = (raw ?? "").trim();
  if (!/^-?\d+$/.test(trimmed)) return Number.NaN;
  return Number(trimmed);
}

export function formToInput(form: ServiceForm): AppointmentServiceInput {
  return {
    code: normalizeCode(form.code),
    nameAr: form.nameAr.trim(),
    nameEn: form.nameEn.trim() || null,
    specialty: form.specialty,
    defaultDurationMinutes: integerOf(form.defaultDurationMinutes),
    bufferBeforeMinutes: integerOf(form.bufferBeforeMinutes),
    bufferAfterMinutes: integerOf(form.bufferAfterMinutes),
    requiresProvider: form.requiresProvider,
    requiresChair: form.requiresChair,
    allowsConcurrentProviderWork: form.allowsConcurrentProviderWork,
    consumesEmergencyReserve: form.consumesEmergencyReserve,
    priority: integerOf(form.priority),
    badgeClass: form.badgeClass.trim() || null,
    isActive: form.isActive,
    sortOrder: integerOf(form.sortOrder),
  };
}

/* ── التصفية ──────────────────────────────────────────────────────────────── */

/**
 * البحثُ من الوحدة لا من الشاشة.
 *
 * `searchServices` هو نفسه الذي تستعمله شاشة الحجز. ومطابقٌ ثانٍ يُكتب هنا معناه
 * أن يجد المالكُ خدمةً في الإعدادات ولا تجدها الاستقبال في الحجز — وهو أسوأ من
 * ألّا يجدها أحد، لأنه لا يُشتكى منه.
 */
export function visibleServices(
  services: AppointmentService[],
  filters: { term?: string; specialty?: ServiceSpecialty | "all"; activity?: ActivityFilter } = {},
): AppointmentService[] {
  const specialty = filters.specialty ?? "all";
  const activity = filters.activity ?? "all";
  return searchServices(services, filters.term ?? "").filter((service) => {
    if (specialty !== "all" && service.specialty !== specialty) return false;
    if (activity === "active" && !service.isActive) return false;
    if (activity === "inactive" && service.isActive) return false;
    return true;
  });
}

/* ── الأعلام بالعربية ─────────────────────────────────────────────────────── */

export type FlagKey =
  | "requiresProvider" | "requiresChair" | "allowsConcurrentProviderWork"
  | "consumesEmergencyReserve" | "isActive";

export interface FlagView {
  key: FlagKey;
  on: boolean;
  /** ما يُقرأ في القائمة — لا `true` ولا `false`. */
  text: string;
}

/**
 * `true` ليست كلمةً عربية، و«نعم» وحدها لا تقول نعمْ لماذا.
 *
 * فكلُّ علمٍ يُقرأ جملةً تصف أثره على اليوم: «يشغل كرسيًّا» يعني كرسيًّا أقلَّ
 * لغيره في تلك الدقائق، لا خانةً مؤشَّرة.
 */
const FLAG_TEXT: Record<FlagKey, { on: string; off: string }> = {
  requiresProvider: { on: "يشغل طبيبًا", off: "لا يشغل طبيبًا" },
  requiresChair: { on: "يشغل كرسيًّا", off: "لا يشغل كرسيًّا" },
  allowsConcurrentProviderWork: {
    on: "يسمح للطبيب بعملٍ متوازٍ", off: "يحجز الطبيب وحده",
  },
  consumesEmergencyReserve: {
    on: "يأكل من حجز الطوارئ", off: "لا يمسّ حجز الطوارئ",
  },
  isActive: { on: "مفعّلة", off: "معطَّلة — لا تُحجز من جديد" },
};

export const FLAG_LABEL: Record<FlagKey, string> = {
  requiresProvider: "تحتاج طبيبًا",
  requiresChair: "تحتاج كرسيًّا",
  allowsConcurrentProviderWork: "تسمح بعملٍ متوازٍ للطبيب",
  consumesEmergencyReserve: "تستهلك حجز الطوارئ",
  isActive: "مفعّلة",
};

export const FLAG_KEYS: FlagKey[] = [
  "requiresProvider", "requiresChair", "allowsConcurrentProviderWork",
  "consumesEmergencyReserve", "isActive",
];

export function flagViews(service: AppointmentService): FlagView[] {
  return FLAG_KEYS.map((key) => {
    const on = Boolean(service[key]);
    return { key, on, text: on ? FLAG_TEXT[key].on : FLAG_TEXT[key].off };
  });
}

/* ── نداءات الخادم ────────────────────────────────────────────────────────── */

export type LoadResult =
  | { ok: true; services: AppointmentService[]; chairs: number }
  | { ok: false; message: string };

export type SaveResult =
  | { ok: true; service: AppointmentService }
  | { ok: false; message: string };

/**
 * `includeInactive=1` هنا وحدها.
 *
 * شاشة الحجز لا تريد المعطَّلة — ولو رأتها لحُجز بها. وشاشة الإعدادات لا تعمل
 * بدونها: خدمةٌ عُطِّلت ثم اختفت من الشاشة لا يمكن إعادة تفعيلها إلا من القاعدة.
 */
export async function fetchServices(): Promise<LoadResult> {
  try {
    const response = await fetch("/api/settings/appointment-services?includeInactive=1", {
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      /* رسالة الخادم عربيةٌ أصلًا (٤٠١/٤٠٣/٥٠٠) — تُعرض كما هي لا تُترجم ثانية. */
      return { ok: false, message: payload?.message ?? "تعذّر تحميل الخدمات." };
    }
    return {
      ok: true,
      services: (payload?.services ?? []) as AppointmentService[],
      chairs: Number(payload?.chairs ?? 0),
    };
  } catch {
    return { ok: false, message: "تعذّر الاتصال بالخادم." };
  }
}

/**
 * الحفظ — والتحقّق قبل الشبكة لا بعدها.
 *
 * `validateService` هو نفسه الذي يحرس الكتابة في الخادم. واستدعاؤه هنا ليس
 * تكرارًا بلا معنى: مدّةٌ خاطئة تُردّ في جزءٍ من الثانية بلا رحلةٍ إلى الخادم،
 * وبنفس الجملة العربية تمامًا التي كان الخادم سيقولها — فلا تختلف الرسالتان.
 *
 * ولا يُرسَل `code` مع التعديل: الخادم يتجاهله على أيّ حال، وإرسالُه يوهم القارئ
 * أنه قابلٌ للتغيير.
 */
export async function submitService(
  form: ServiceForm, editingId: number | null,
): Promise<SaveResult> {
  const input = formToInput(form);
  const problem = validateService(input);
  if (problem) return { ok: false, message: problem };

  const isEdit = editingId !== null;
  const { code: _code, ...withoutCode } = input;
  const body = isEdit ? withoutCode : input;

  try {
    const response = await fetch(
      isEdit
        ? `/api/settings/appointment-services/${editingId}`
        : "/api/settings/appointment-services",
      {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, message: payload?.message ?? "تعذّر حفظ الخدمة." };
    return { ok: true, service: payload as AppointmentService };
  } catch {
    return { ok: false, message: "تعذّر الاتصال بالخادم." };
  }
}

/**
 * التعطيل والتفعيل — حقلٌ واحد لا النموذج كلّه.
 *
 * التعديل في الخادم جزئيّ: ما لم يُرسَل يبقى كما هو. فإرسال `isActive` وحده يعني
 * أن نقرةً على «تعطيل» لا يمكن أن تكتب فوق مدّةٍ عدّلها زميلٌ قبل ثانية.
 */
export async function setServiceActive(
  service: AppointmentService, next: boolean,
): Promise<SaveResult> {
  try {
    const response = await fetch(`/api/settings/appointment-services/${service.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: next }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, message: payload?.message ?? "تعذّر تغيير حالة الخدمة." };
    }
    return { ok: true, service: payload as AppointmentService };
  } catch {
    return { ok: false, message: "تعذّر الاتصال بالخادم." };
  }
}

/* ── العرض ────────────────────────────────────────────────────────────────── */

const fieldClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs outline-none focus:border-brand-blue disabled:bg-slate-100";
const labelClass = "mb-1 block text-[11px] font-bold text-slate-600";

/** بطاقةُ خدمةٍ واحدة — قائمةٌ لا جدول، كي تُقرأ على هاتفٍ بعرض ٣٦٠ بكسل. */
export function ServicesTable({ services, onEdit, onToggle, busy = false }: {
  services: AppointmentService[];
  onEdit?: (service: AppointmentService) => void;
  onToggle?: (service: AppointmentService) => void;
  busy?: boolean;
}) {
  if (services.length === 0) {
    return (
      <p
        data-testid="services-empty"
        className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-xs font-bold text-slate-500"
      >
        لا خدمةَ تطابق البحث أو التصفية.
      </p>
    );
  }

  return (
    <ul data-testid="services-list" className="space-y-2">
      {services.map((service) => (
        <li
          key={service.id}
          data-testid="service-row"
          data-service-code={service.code}
          data-service-active={service.isActive ? "1" : "0"}
          className={`rounded-xl border p-3 ${
            service.isActive ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50"
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2">
                <span data-testid="service-name" className="text-sm font-extrabold text-navy-900">
                  {service.nameAr}
                </span>
                <span
                  data-testid="service-code"
                  dir="ltr"
                  className="rounded-lg bg-slate-100 px-2 py-0.5 text-[10px] font-bold tracking-wide text-slate-600"
                >
                  {service.code}
                </span>
                <span
                  data-testid="service-specialty"
                  className="rounded-lg bg-navy-50 px-2 py-0.5 text-[10px] font-bold text-navy-800"
                >
                  {SPECIALTY_LABEL[service.specialty]}
                </span>
                {!service.isActive ? (
                  <span
                    data-testid="service-disabled-badge"
                    className="rounded-lg border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-extrabold text-amber-800"
                  >
                    معطَّلة
                  </span>
                ) : null}
              </p>
              {service.nameEn ? (
                <p dir="ltr" className="mt-0.5 text-[10px] text-slate-400">{service.nameEn}</p>
              ) : null}
              <p data-testid="service-timing" className="mt-1 text-[11px] font-bold text-slate-600">
                المدة {service.defaultDurationMinutes} دقيقة · تجهيز قبلها{" "}
                {service.bufferBeforeMinutes} دقيقة · بعدها {service.bufferAfterMinutes} دقيقة
              </p>
              <ul data-testid="service-flags" className="mt-1.5 flex flex-wrap gap-1.5">
                {flagViews(service).map((flag) => (
                  <li
                    key={flag.key}
                    data-flag={flag.key}
                    data-flag-on={flag.on ? "1" : "0"}
                    className={`rounded-lg px-2 py-0.5 text-[10px] font-bold ${
                      flag.on ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {flag.text}
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="service-edit"
                data-service-code={service.code}
                onClick={() => onEdit?.(service)}
                disabled={busy}
                className="rounded-xl border border-slate-200 px-3 py-1.5 text-[11px] font-bold text-navy-800 hover:bg-navy-50 disabled:opacity-50"
              >
                <span className="inline-flex items-center gap-1">
                  <Icon name="edit" className="h-3.5 w-3.5" />
                  تحرير
                </span>
              </button>
              <button
                type="button"
                data-testid="service-toggle"
                data-service-code={service.code}
                aria-pressed={service.isActive}
                onClick={() => onToggle?.(service)}
                disabled={busy}
                className={`rounded-xl px-3 py-1.5 text-[11px] font-extrabold text-white disabled:opacity-50 ${
                  service.isActive
                    ? "bg-emerald-600 hover:bg-emerald-700"
                    : "bg-slate-500 hover:bg-slate-600"
                }`}
              >
                {service.isActive ? "مفعّلة — انقر للتعطيل" : "معطَّلة — انقر للتفعيل"}
              </button>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** حقول النموذج — مكتوبةُ النوع، ولكلّ حقلٍ عنوانٌ حقيقيّ مرتبطٌ بمعرّفه. */
export function ServiceFormFields({ form, mode, onChange }: {
  form: ServiceForm;
  mode: "create" | "edit";
  onChange: (patch: Partial<ServiceForm>) => void;
}) {
  const normalized = normalizeCode(form.code);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="svc-code">رمز الخدمة</label>
          <input
            id="svc-code"
            data-testid="field-code"
            dir="ltr"
            value={form.code}
            readOnly={mode === "edit"}
            aria-describedby="svc-code-note"
            onChange={(event) => onChange({ code: event.target.value })}
            placeholder="ORTHO_FOLLOW_UP"
            className={`${fieldClass} ${mode === "edit" ? "bg-slate-100 text-slate-500" : ""}`}
          />
          {mode === "edit" ? (
            <p id="svc-code-note" data-testid="code-immutable-note" className="mt-1 text-[10px] leading-relaxed text-amber-800">
              الرمز هوية: المواعيد المحجوزة تشير إليه، فلا يتغيّر. من أراد رمزًا آخر
              يعطّل هذه الخدمة وينشئ غيرها.
            </p>
          ) : (
            <p id="svc-code-note" data-testid="code-normalize-note" className="mt-1 text-[10px] leading-relaxed text-slate-500">
              سيُحفظ هكذا: <span dir="ltr" data-testid="code-normalized" className="font-bold text-slate-700">{normalized || "—"}</span>{" "}
              — المسافات والشرطات تصير شرطةً سفلية والحروف تُرفع. أمّا رمزٌ خارج
              الحروف اللاتينية والأرقام فيُرَدّ برسالةٍ ولا يُعاد كتابته خلف ظهرك.
            </p>
          )}
        </div>

        <div>
          <label className={labelClass} htmlFor="svc-specialty">التخصص</label>
          <select
            id="svc-specialty"
            data-testid="field-specialty"
            value={form.specialty}
            onChange={(event) => onChange({ specialty: event.target.value as ServiceSpecialty })}
            className={fieldClass}
          >
            {SPECIALTIES.map((specialty) => (
              <option key={specialty} value={specialty}>{SPECIALTY_LABEL[specialty]}</option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor="svc-name-ar">اسم الخدمة بالعربية</label>
          <input
            id="svc-name-ar"
            data-testid="field-name-ar"
            value={form.nameAr}
            onChange={(event) => onChange({ nameAr: event.target.value })}
            placeholder="متابعة تقويم / شدّ"
            className={fieldClass}
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="svc-name-en">الاسم بالإنجليزية (اختياري)</label>
          <input
            id="svc-name-en"
            data-testid="field-name-en"
            dir="ltr"
            value={form.nameEn}
            onChange={(event) => onChange({ nameEn: event.target.value })}
            className={fieldClass}
          />
        </div>
      </div>

      <div className="rounded-xl border border-amber-300 bg-amber-50 p-3">
        <p className="text-[11px] font-extrabold text-amber-900">
          هذه الأرقام تُغيّر كم مريضًا يستقبل المركز في اليوم
        </p>
        <p data-testid="capacity-warning" className="mt-1 text-[11px] leading-relaxed text-amber-800">
          المدّة والتجهيز قبلها وبعدها هي ما يحسب به محرّك السعة نافذةَ الإشغال على
          الكرسي والطبيب. رفعُ متابعةٍ من عشر دقائق إلى خمس عشرة يُنقص طاقة المساء
          الثلاثين إلى عشرين — بلا رسالةِ خطأٍ واحدة، فقط مواعيدُ لا تُقبل.
          <br />
          <strong>والمواعيد المحجوزة لا تتأثّر:</strong> كلُّ موعدٍ يحتفظ بالمدّة
          والفواصل التي حُجز بها، والتغيير هنا يسري على الحجوزات الجديدة وحدها.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={labelClass} htmlFor="svc-duration">
            المدة الافتراضية (دقيقة)
          </label>
          <input
            id="svc-duration"
            data-testid="field-duration"
            type="number"
            inputMode="numeric"
            min={MIN_DURATION}
            max={MAX_DURATION}
            value={form.defaultDurationMinutes}
            onChange={(event) => onChange({ defaultDurationMinutes: event.target.value })}
            className={`${fieldClass} tabular-nums`}
          />
          <p className="mt-1 text-[10px] text-slate-500">
            من {MIN_DURATION} إلى {MAX_DURATION} دقيقة.
          </p>
        </div>

        <div>
          <label className={labelClass} htmlFor="svc-buffer-before">
            تجهيز قبل الموعد (دقيقة)
          </label>
          <input
            id="svc-buffer-before"
            data-testid="field-buffer-before"
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_BUFFER}
            value={form.bufferBeforeMinutes}
            onChange={(event) => onChange({ bufferBeforeMinutes: event.target.value })}
            className={`${fieldClass} tabular-nums`}
          />
          <p className="mt-1 text-[10px] text-slate-500">
            صفرٌ قيمةٌ صحيحة — لا تفرض دقائق «للنظافة» تأكل ساعتين من يومك.
          </p>
        </div>

        <div>
          <label className={labelClass} htmlFor="svc-buffer-after">
            تجهيز بعد الموعد (دقيقة)
          </label>
          <input
            id="svc-buffer-after"
            data-testid="field-buffer-after"
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_BUFFER}
            value={form.bufferAfterMinutes}
            onChange={(event) => onChange({ bufferAfterMinutes: event.target.value })}
            className={`${fieldClass} tabular-nums`}
          />
          <p className="mt-1 text-[10px] text-slate-500">حتى {MAX_BUFFER} دقيقة.</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={labelClass} htmlFor="svc-priority">الأولوية</label>
          <input
            id="svc-priority"
            data-testid="field-priority"
            type="number"
            inputMode="numeric"
            min={MIN_PRIORITY}
            max={MAX_PRIORITY}
            value={form.priority}
            onChange={(event) => onChange({ priority: event.target.value })}
            className={`${fieldClass} tabular-nums`}
          />
          <p className="mt-1 text-[10px] text-slate-500">
            الأصغرُ أهمّ: الطوارئ ١٠ والمراجعة العابرة ٦٠.
          </p>
        </div>

        <div>
          <label className={labelClass} htmlFor="svc-sort">ترتيب العرض</label>
          <input
            id="svc-sort"
            data-testid="field-sort"
            type="number"
            inputMode="numeric"
            min={0}
            max={9999}
            value={form.sortOrder}
            onChange={(event) => onChange({ sortOrder: event.target.value })}
            className={`${fieldClass} tabular-nums`}
          />
          <p className="mt-1 text-[10px] text-slate-500">
            ترتيبها في قائمة الحجز — الأكثر استعمالًا أوّلًا يوفّر نقرات.
          </p>
        </div>

        <div>
          <label className={labelClass} htmlFor="svc-badge">
            صنف الشارة اللونية (اختياري)
          </label>
          <input
            id="svc-badge"
            data-testid="field-badge"
            dir="ltr"
            value={form.badgeClass}
            onChange={(event) => onChange({ badgeClass: event.target.value })}
            placeholder="border-indigo-200 bg-indigo-50 text-indigo-800"
            className={fieldClass}
          />
        </div>
      </div>

      <fieldset className="rounded-xl border border-slate-200 p-3">
        <legend className="px-1 text-[11px] font-extrabold text-navy-900">
          ماذا تشغل هذه الخدمة؟
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {FLAG_KEYS.map((key) => (
            <div key={key} className="flex items-center gap-2">
              <input
                id={`svc-flag-${key}`}
                data-testid={`field-flag-${key}`}
                type="checkbox"
                checked={form[key]}
                onChange={(event) => onChange({ [key]: event.target.checked } as Partial<ServiceForm>)}
                className="h-4 w-4 rounded border-slate-300"
              />
              <label className="text-[11px] font-bold text-slate-700" htmlFor={`svc-flag-${key}`}>
                {FLAG_LABEL[key]}
              </label>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
          خدمةٌ لا تشغل طبيبًا ولا كرسيًّا لا تُحسب في السعة أصلًا — تُقبل، لكن اعرف
          أنك أخرجتها من حساب الزحمة.
        </p>
      </fieldset>
    </div>
  );
}

/* ── الشاشة ───────────────────────────────────────────────────────────────── */

export default function AppointmentServicesPage() {
  const [services, setServices] = useState<AppointmentService[] | null>(null);
  const [chairs, setChairs] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const [specialtyFilter, setSpecialtyFilter] = useState<ServiceSpecialty | "all">("all");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [editor, setEditor] = useState<{ id: number | null; form: ServiceForm } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await fetchServices();
    if (!result.ok) {
      /* ٤٠٣ ليست شاشةً بيضاء: تُقال الرسالة العربية التي جاءت من الخادم. */
      setLoadError(result.message);
      setServices([]);
      return;
    }
    setLoadError(null);
    setServices(result.services);
    setChairs(result.chairs);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(
    () => visibleServices(services ?? [], {
      term, specialty: specialtyFilter, activity: activityFilter,
    }),
    [services, term, specialtyFilter, activityFilter],
  );

  const patchForm = (patch: Partial<ServiceForm>) =>
    setEditor((current) => (current ? { ...current, form: { ...current.form, ...patch } } : current));

  const submit = async () => {
    if (!editor || busy) return;
    setFormError(null);
    setBusy(true);
    const result = await submitService(editor.form, editor.id);
    setBusy(false);
    if (!result.ok) {
      setFormError(result.message);
      return;
    }
    setNotice(editor.id === null
      ? `أُضيفت «${result.service.nameAr}» — تظهر في قائمة الحجز الآن.`
      : `حُفظت «${result.service.nameAr}» — والمواعيد المحجوزة سلفًا بمدّتها القديمة.`);
    setEditor(null);
    await load();
  };

  const toggle = async (service: AppointmentService) => {
    if (busy) return;
    setFormError(null);
    setBusy(true);
    const result = await setServiceActive(service, !service.isActive);
    setBusy(false);
    if (!result.ok) {
      setFormError(result.message);
      return;
    }
    setServices((current) =>
      (current ?? []).map((row) => (row.id === result.service.id ? result.service : row)));
    setNotice(result.service.isActive
      ? `فُعِّلت «${result.service.nameAr}» — تُحجز من جديد.`
      : `عُطِّلت «${result.service.nameAr}» — لا حجزَ جديدًا بها، ومواعيدها القديمة كما هي.`);
  };

  return (
    <main dir="rtl" className="mx-auto max-w-4xl p-4 pb-16">
      <PageHeader
        title="خدمات المواعيد"
        subtitle="كتالوج ما يُحجز في المركز — مدّته وفواصله وما يشغله من كرسيٍّ وطبيب"
        links={[
          { href: "/settings", label: "الإعدادات المركزية" },
          { href: "/settings/appointment-services", label: "خدمات المواعيد", current: true },
          { href: "/settings/material-rates", label: "نسب إهلاك المواد" },
        ]}
      >
        <button
          type="button"
          data-testid="add-service"
          onClick={() => { setFormError(null); setEditor({ id: null, form: emptyForm() }); }}
          className="rounded-xl bg-navy-800 px-4 py-2 text-xs font-extrabold text-white"
        >
          <span className="inline-flex items-center gap-1">
            <Icon name="plus" className="h-3.5 w-3.5" />
            خدمة جديدة
          </span>
        </button>
      </PageHeader>

      {loadError ? (
        <p
          role="alert"
          data-testid="load-error"
          className="mb-3 rounded-xl border border-rose-300 bg-rose-50 px-4 py-2 text-xs font-bold text-rose-900"
        >
          {loadError}
        </p>
      ) : null}

      {notice ? (
        <p
          data-testid="notice"
          className="mb-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-2 text-xs font-bold text-sky-900"
        >
          {notice}
        </p>
      ) : null}

      <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-[11px] leading-relaxed text-slate-600">
          كلُّ خدمةٍ هنا سطرٌ في قائمة الحجز، ومدّتُها وفواصلها مدخلاتُ محرّك السعة.
          {chairs !== null ? ` وعدد الكراسي المعتمد اليوم ${chairs}.` : ""}
        </p>
        <p data-testid="no-delete-note" className="mt-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
          <strong>لماذا لا يوجد زرُّ محو؟</strong> خدمةٌ حُجزت بها مواعيد إن مُحيت صار
          تاريخُ المركز يشير إلى لا شيء: موعدُ العام الماضي بلا اسم، وتقريرُ الأمس
          بسطرٍ فارغ. فالخدمة التي انتهى العمل بها <strong>تُعطَّل</strong> — يمتنع
          الحجز الجديد بها ويبقى القديم مقروءًا باسمه.
        </p>
      </section>

      <section className="mb-4 grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:grid-cols-3">
        <div>
          <label className={labelClass} htmlFor="svc-search">بحث</label>
          <input
            id="svc-search"
            data-testid="search-input"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="اسمٌ عربيّ أو رمزٌ أو تخصّص"
            className={fieldClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="svc-filter-specialty">التخصص</label>
          <select
            id="svc-filter-specialty"
            data-testid="filter-specialty"
            value={specialtyFilter}
            onChange={(event) =>
              setSpecialtyFilter(event.target.value as ServiceSpecialty | "all")}
            className={fieldClass}
          >
            <option value="all">كل التخصصات</option>
            {SPECIALTIES.map((specialty) => (
              <option key={specialty} value={specialty}>{SPECIALTY_LABEL[specialty]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="svc-filter-activity">الحالة</label>
          <select
            id="svc-filter-activity"
            data-testid="filter-activity"
            value={activityFilter}
            onChange={(event) => setActivityFilter(event.target.value as ActivityFilter)}
            className={fieldClass}
          >
            <option value="all">المفعّلة والمعطَّلة</option>
            <option value="active">المفعّلة فقط</option>
            <option value="inactive">المعطَّلة فقط</option>
          </select>
        </div>
      </section>

      {editor ? (
        <section data-testid="service-editor" className="mb-4 rounded-2xl border border-navy-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-extrabold text-navy-900">
            {editor.id === null ? "خدمة جديدة" : `تحرير: ${editor.form.nameAr || editor.form.code}`}
          </h2>

          {formError ? (
            <p
              role="alert"
              data-testid="form-error"
              className="mb-3 rounded-xl border border-rose-300 bg-rose-50 px-4 py-2 text-xs font-bold text-rose-900"
            >
              {formError}
            </p>
          ) : null}

          <ServiceFormFields
            form={editor.form}
            mode={editor.id === null ? "create" : "edit"}
            onChange={patchForm}
          />

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              data-testid="cancel-service"
              onClick={() => { setEditor(null); setFormError(null); }}
              disabled={busy}
              className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 disabled:opacity-50"
            >
              إلغاء
            </button>
            <button
              type="button"
              data-testid="save-service"
              onClick={() => void submit()}
              disabled={busy}
              className="rounded-xl bg-navy-800 px-5 py-2 text-xs font-extrabold text-white disabled:opacity-40"
            >
              {busy ? "جارٍ الحفظ…" : "حفظ"}
            </button>
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-xs font-extrabold text-navy-900">
          الخدمات ({shown.length})
        </h2>
        {services === null ? (
          <p className="text-xs text-slate-400">جارٍ التحميل…</p>
        ) : (
          <ServicesTable
            services={shown}
            busy={busy}
            onEdit={(service) => {
              setFormError(null);
              setEditor({ id: service.id, form: formFromService(service) });
            }}
            onToggle={(service) => void toggle(service)}
          />
        )}
      </section>
    </main>
  );
}
