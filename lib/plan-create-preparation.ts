import type { AuditInput, createPlan, createPlanV2, Service } from "./db";
import type { SettingsMap } from "./settings";
import { buildTemplateDrafts, effectiveTemplates } from "./specialty-templates";
import { agreementPricedService, checkInvoiceAuthority, formatPriceOverrides, type InvoiceLineAuthorityInput } from "./invoice-pricing";
import { foreignRatesFromSettings } from "./service-pricing";
import { splitInstallments } from "./plans";
import { checkPlanAgreementPricing } from "./plan-agreement-pricing";
import { normalizeBillingRule, normalizeSessionCount, type BillingRule } from "./workflow";
import { isCurrency, parseAmount, CLINIC_BASE_CURRENCY } from "./money";
import { MAX_SELECTED_TEETH, isValidTooth } from "./dental";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type PreparedAudit = Omit<AuditInput, "entityId">;
export type PreparedPlanCreate =
  | { writer: "legacy"; input: Parameters<typeof createPlan>[0]; audit: null; failureMessage: string }
  | { writer: "v2"; input: Parameters<typeof createPlanV2>[0]; audit: PreparedAudit; failureMessage: string };

export type PlanCreatePreparation =
  | { ok: true; plan: PreparedPlanCreate }
  | { ok: false; status: 400 | 500; body: { message: string; code?: string } };

export interface PlanCreatePreparationDependencies {
  getSettings: () => Promise<SettingsMap>;
  listServices: () => Promise<Service[]>;
  clinicDate: () => string;
}

const failure = (status: 400 | 500, body: { message: string; code?: string }): PlanCreatePreparation =>
  ({ ok: false, status, body });

/**
 * Resolve a NEW create only. Authentication/patient authorization and any future
 * replay lookup belong to the caller and must finish before invoking this.
 * Inject transaction-bound readers for a command; the current HTTP route keeps
 * its public pooled readers. This module owns no connection, writes or audit.
 *
 * Reader call order and legacy exception boundaries intentionally match POST:
 * template selection and V2 catalog reads may reject; template draft preparation
 * maps failures to its 500 response. Mutable defaults are not cached here.
 * patientId is the caller's already-coerced value, preserving pre-auth timing.
 */
export async function resolvePlanCreatePreparation(
  source: Record<string, unknown>,
  patientId: number,
  actor: { username: string; role: string },
  dependencies: PlanCreatePreparationDependencies,
): Promise<PlanCreatePreparation> {
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return failure(400, { message: "اختر المريض أولًا." });
  }
  const title = typeof source.title === "string" ? source.title.trim() : "";
  if (!title || title.length > 120) {
    return failure(400, { message: "اكتب اسم الخطة — مثل: تقويم ثابت فكّين." });
  }

  /* (TD-05) عملة الاتفاق من الطلب — YER/SAR/USD حسب اتفاق المريض، والافتراضي
     هو العملة الأساسية. لا يفرض الخادم عملةً واحدة على كل الاتفاقات بعد اليوم.
     وعملةٌ غير معروفة تُرفض صراحةً لا تُبدَّل بصمت. */
  const requestedCurrency = source.currency;
  if (requestedCurrency !== undefined && requestedCurrency !== null
    && String(requestedCurrency).trim() !== "" && !isCurrency(requestedCurrency)) {
    return failure(400, { message: "عملة الخطة يجب أن تكون YER أو SAR أو USD." });
  }
  const base = isCurrency(requestedCurrency) ? requestedCurrency : CLINIC_BASE_CURRENCY;

  const today = dependencies.clinicDate();
  const startDate = typeof source.startDate === "string" && DATE_PATTERN.test(source.startDate)
    ? source.startDate : today;
  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;

  /*
   * ── الرحلة V2: نموذجٌ واحد زرٌّ واحد ──
   *
   * `mode: "v2"` يبني الخطة كاملة في معاملة واحدة: بنودها المسعَّرة بقواعد
   * الفوترة وجلساتها، وزياراتها المخطَّطة، وطريقة دفعها (حسب المنفَّذ أو أقساط
   * أو جدول مخصص). والمساران القديمان (clinical/financial) يبقيان كما هما —
   * واجهات قديمة واختبارات تعمل بها، وتُزال حين تثبت الواجهة الجديدة (المواصفة §٤٢).
   */
  /*
   * (SPEC-T1) خطة من قالب التخصص: الطبيب يختار القالب والأسنان والخدمة الدقيقة لكل خطوة،
   * والخادم وحده يبني البنود وجلساتها ويسعّرها من الدليل بعملة الخطة — لا سعر من الطلب.
   * ثم تمرّ بـcreatePlanV2 نفسها: خطةٌ عادية تُعدَّل وتُوافَق وتُفوتر كما هي.
   */
  if (source.mode === "template") {
    const template = effectiveTemplates((await dependencies.getSettings())["plans.specialty_templates"])
      .templates.find((item) => item.id === source.templateId);
    if (!template) return failure(400, { message: "قالب التخصص غير موجود." });
    /* الأسنان كما اختيرت على المخطط: FDI صالحة وبلا تكرار — ولا قصٌّ صامت: ما زاد عن الحد
       يُرفض برسالة، وإلا أُنشئت الخطة ناقصةً بإجماليٍّ غير الذي رآه الطبيب (مراجعة #117). */
    const rawTeeth = (Array.isArray(source.teeth) ? source.teeth : []).map((tooth) => Number(tooth));
    const invalidTooth = rawTeeth.find((tooth) => !isValidTooth(tooth));
    if (invalidTooth !== undefined) {
      return failure(400, { message: `«${String(invalidTooth)}» ليس رقم سنٍّ صالحًا بترقيم FDI.` });
    }
    const teeth = [...new Set(rawTeeth)];
    if (teeth.length > MAX_SELECTED_TEETH) {
      return failure(400, { message: `اختر ${MAX_SELECTED_TEETH} سنًّا بحدٍّ أقصى.` });
    }
    const steps = (Array.isArray(source.steps) ? source.steps : []).slice(0, 20).map((raw) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      return {
        key: typeof row.key === "string" ? row.key : "",
        include: row.include === true,
        serviceId: Number(row.serviceId) > 0 ? Number(row.serviceId) : null,
      };
    });
    const primaryDoctorId = Number(source.primaryDoctorId) > 0 ? Number(source.primaryDoctorId) : null;
    try {
      const [services, settings] = await Promise.all([dependencies.listServices(), dependencies.getSettings()]);
      const built = buildTemplateDrafts(template, { teeth, steps }, services, base, foreignRatesFromSettings(settings));
      if (!built.ok) return failure(400, { message: built.message });
      return {
        ok: true,
        plan: {
          writer: "v2",
          input: {
            patientId, title, specialty: template.specialty, primaryDoctorId,
            billingMode: "per_procedure", baseCurrency: base, startDate, note,
            items: built.drafts.map((draft) => ({
              serviceId: draft.serviceId, serviceName: draft.serviceName, category: draft.category,
              toothCode: draft.toothCode, surfaces: null, quantity: 1, unitPriceMinor: draft.unitPriceMinor,
              billingRule: draft.billingRule, sessionCount: draft.sessions.length, note: null,
              sessionPlan: draft.sessions,
            })),
            installments: [], createdBy: actor.username,
          },
          audit: {
            action: "plan.create_v2", entity: "treatment_plan", entityLabel: title,
            details: {
              القالب: template.name,
              الأسنان: teeth.length ? teeth.join("، ") : null,
              البنود: built.drafts.length,
              الجلسات: built.drafts.reduce((sum, draft) => sum + draft.sessions.length, 0),
            },
            actor: actor.username, actorRole: actor.role,
          },
          failureMessage: "تعذّر إنشاء الخطة من القالب.",
        },
      };
    } catch {
      return failure(500, { message: "تعذّر إنشاء الخطة من القالب." });
    }
  }

  if (source.mode === "v2") {
    /*
     * (FIN-5) بنود الخطة اليدوية بسلطة السعر نفسها التي تحكم الزيارة والفاتورة: جلسة بند الخطة
     * تُفوتَر بسعر الخطة، فسعرٌ مكتوب هنا هو سعر الفاتورة لاحقًا. كل بندٍ خدمةٌ من الدليل (الاسم
     * والفئة منه لا من الطلب)، وسعرها المكتوب يُقارن بسعر الدليل بعملة الخطة — الخصم بسببٍ
     * مكتوب وفي حدّ الإعدادات لغير المدير، والرفع للمدير وحده.
     */
    const rawItems = (Array.isArray(source.items) ? source.items : []).slice(0, 100)
      .map((row) => (row ?? {}) as Record<string, unknown>);
    const [catalog, settings] = rawItems.length > 0
      ? await Promise.all([dependencies.listServices(), dependencies.getSettings()]) : [[], null];
    const items: Parameters<typeof createPlanV2>[0]["items"] = [];
    const authorityLines: InvoiceLineAuthorityInput[] = [];
    for (const row of rawItems) {
      const service = catalog.find((item) => item.id === Number(row.serviceId));
      if (!service) return failure(400, { message: "اختر خدمة كل بند من الدليل." });
      const quantity = Math.max(1, Math.round(Number(row.quantity) || 1));
      const unitPriceMinor = Math.max(0, Math.round(Number(row.unitPriceMinor) || 0));
      items.push({
        serviceId: service.id,
        serviceName: service.name,
        category: service.category,
        toothCode: Number(row.toothCode) > 0 ? Number(row.toothCode) : null,
        surfaces: typeof row.surfaces === "string" && row.surfaces.trim() ? row.surfaces : null,
        quantity,
        unitPriceMinor,
        billingRule: normalizeBillingRule(row.billingRule) as BillingRule,
        sessionCount: normalizeSessionCount(row.sessionCount),
        note: typeof row.note === "string" && row.note.trim()
          ? row.note.trim().slice(0, 300) : null,
      });
      authorityLines.push({
        description: service.name, service: agreementPricedService(service, base), requestedMinor: unitPriceMinor, quantity, explicit: true,
        reason: typeof row.priceReason === "string" ? row.priceReason : null,
      });
    }
    const authority = settings ? checkInvoiceAuthority({
      lines: authorityLines,
      currency: base,
      rates: foreignRatesFromSettings(settings),
      role: actor.role,
      maxDiscountPercent: Number(settings["billing.max_discount_percent"]),
      totalMinor: items.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0),
      discountMinor: 0,
      discountReason: null,
    }) : { ok: true as const, overrides: [], discount: null };
    if (!authority.ok) return failure(400, { message: authority.message });

    const billingModeRaw = String(source.billingMode ?? "per_procedure");
    const billingMode =
      billingModeRaw === "installments" || billingModeRaw === "custom_schedule"
        ? billingModeRaw
        : items.length > 0 ? "per_procedure" : "installments";

    // الأقساط: جدولٌ جاهز (count/everyDays) أو جدولٌ مخصص (سطور بتواريخها).
    const installments: { dueDate: string; amountMinor: number }[] = [];
    if (billingMode === "installments" || Array.isArray(source.installments)) {
      if (Array.isArray(source.installments)) {
        for (const raw of source.installments) {
          const row = raw as Record<string, unknown>;
          const dueDate = typeof row.dueDate === "string" && DATE_PATTERN.test(row.dueDate)
            ? row.dueDate : "";
          const amountMinor = Math.round(Number(row.amountMinor) || 0);
          if (dueDate && amountMinor > 0) installments.push({ dueDate, amountMinor });
        }
      }
      if (installments.length === 0) {
        const totalMinor = parseAmount(String(source.total ?? ""), base) ?? 0;
        const count = Math.round(Number(source.count ?? 0));
        const everyDays = Math.round(Number(source.everyDays ?? 30));
        if (totalMinor > 0 && count >= 1 && count <= 60 && everyDays >= 1 && everyDays <= 365) {
          for (const part of splitInstallments(totalMinor, count, startDate, everyDays)) {
            installments.push({ dueDate: part.dueDate, amountMinor: part.amountMinor });
          }
        }
      }
    }

    const agreementPricing = checkPlanAgreementPricing({
      pricingMode: source.pricingMode, total: source.total, currency: base, items, installments,
    });
    if (!agreementPricing.ok) {
      return failure(400, { code: agreementPricing.code, message: agreementPricing.message });
    }

    if (items.length === 0 && installments.length === 0) {
      return failure(400, { message: "أضف بنود الخطة أو المبلغ المتفق عليه مع جدول أقساطه." });
    }

    try {
      const specialty = typeof source.specialty === "string" && source.specialty.trim()
        ? source.specialty.trim().slice(0, 80) : null;
      const primaryDoctorId = Number(source.primaryDoctorId) > 0
        ? Number(source.primaryDoctorId) : null;

      return {
        ok: true,
        plan: {
          writer: "v2",
          input: {
            patientId, title, specialty, primaryDoctorId,
            billingMode, baseCurrency: base, startDate, note,
            items, installments, createdBy: actor.username,
          },
          audit: {
            action: "plan.create_v2", entity: "treatment_plan",
            entityLabel: title,
            details: {
              البنود: items.length,
              الجلسات: items.reduce((sum, item) => sum + item.sessionCount, 0),
              طريقة_الدفع: billingMode,
              الأقساط: installments.length,
              ...(authority.overrides.length ? { أسعار_معدلة: formatPriceOverrides(authority.overrides) } : {}),
            },
            actor: actor.username, actorRole: actor.role,
          },
          failureMessage: "تعذّر إنشاء الخطة. تأكد من المريض.",
        },
      };
    } catch {
      return failure(500, { message: "تعذّر إنشاء الخطة. تأكد من المريض." });
    }
  }

  /*
   * المساران القديمان — طريقان لخطةٍ واحدة، لا نوعان من الخطط.
   *
   * «مالية»: مبلغٌ متفَقٌ عليه يُقسَّط، وهو ما يكفي مريض التقويم الذي اتفق على رقم.
   * «سريرية»: تُنشأ فارغة ثم تُبنى ببنودها، فيُشتقّ إجماليّها منها. والكائن واحد في
   * الحالتين — لأن مريضًا واحدًا قد يبدأ بحشواتٍ مفصَّلة ثم يقسّط ما اتفق عليه.
   */
  const clinical = source.mode === "clinical";

  const totalMinor = clinical ? 0 : parseAmount(String(source.total ?? ""), base);
  if (totalMinor === null || (!clinical && totalMinor <= 0)) {
    return failure(400, { message: "اكتب المبلغ الإجمالي المتفق عليه." });
  }

  const count = Math.round(Number(source.count ?? 1));
  if (!clinical && (!Number.isFinite(count) || count < 1 || count > 60)) {
    return failure(400, { message: "عدد الأقساط بين 1 و60." });
  }
  const everyDays = Math.round(Number(source.everyDays ?? 30));
  if (!clinical && (!Number.isFinite(everyDays) || everyDays < 1 || everyDays > 365)) {
    return failure(400, { message: "المدة بين الأقساط بين 1 و365 يومًا." });
  }

  try {
    return {
      ok: true,
      plan: {
        writer: "legacy",
        input: {
          patientId, title, totalMinor, baseCurrency: base, startDate, note,
          createdBy: actor.username,
          installments: clinical ? [] : splitInstallments(totalMinor, count, startDate, everyDays),
        },
        audit: null,
        failureMessage: "تعذّر إنشاء الخطة. تأكد من المريض.",
      },
    };
  } catch {
    return failure(500, { message: "تعذّر إنشاء الخطة. تأكد من المريض." });
  }
}
