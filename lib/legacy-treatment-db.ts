/**
 * (INV-LEGACY) علاجٌ بدأ قبل النظام — داخل مسار الربط السريري للفاتورة، في معاملةٍ واحدة.
 *
 * اتفاقٌ تاريخي (المتفق، والمدفوع قبل النظام، والمتبقي عند البدء، وتاريخ المعلومات، والعملة) ← بند خطة (هوية العمل،
 * موافَقٌ عليه بالاتفاق التاريخي، مغطّى فلا تفوتره الزيارات) ← حالة تخصصية (تُعاد المفتوحة الموافقة، أو تُجسَر حالة
 * التقويم القائمة، أو تُفتح حالةٌ موسومة «حالة بدأت قبل النظام» — بلا تفاصيل سريرية مختلقة).
 *
 * المال: لا سند للمدفوع سابقًا ولا حركة صندوق/وردية ولا فاتورة. المتبقي وحده رصيدٌ سابق — بمحرّك الرصيد الافتتاحي
 * القائم نفسه (`setPatientOpeningBalanceInTx` بأقفاله وسجلّه، والإضافة فقط لمن لا يملك التعديل). والإبطال (للمدير)
 * يصحّح الرصيد بمسار المحرّك نفسه (تعديل أو مسح بسجلّه) ويحرّر التغطية — ولا يحذف شيئًا.
 * التصميم: docs/INVOICE_FIRST_LEGACY_TREATMENT.md.
 */
import {
  CLINIC_TIME_ZONE, OpeningBalanceChanged, OpeningBalanceExists, clearPatientOpeningBalanceInTx, ensureSchema,
  getPool, insertAuditRow, insertPlanV2InTx, isPeriodLocked, setPatientOpeningBalanceInTx,
  type AuditInput, type DbClient,
} from "./db";
import {
  LINKAGE_SPECIALTY_LABEL, caseSiteFits, lineLinkage, scopeNote, sessionsFor, siteText, validateLineSite,
} from "./invoice-clinical-linkage";
import { openingPosition } from "./legacy-balance-arrangements-db";
import {
  legacyCaseTitle, legacyTreatmentFingerprint,
  type LegacyTreatmentRefusal, type LegacyTreatmentRequest, type LegacyVoidRefusal,
} from "./legacy-treatment";
import { formatMoney, isCurrency, type Currency } from "./money";
import { clinicDateString } from "./schedule";
import type { SpecialtyTemplate } from "./specialty-templates";

export interface LegacyAgreementView {
  id: number;
  patientId: number;
  planItemId: number;
  planId: number;
  caseId: number | null;
  caseTitle: string | null;
  serviceId: number;
  serviceName: string;
  specialty: string;
  specialtyLabel: string;
  toothCode: number | null;
  currency: Currency;
  agreedMinor: number;
  previouslyPaidMinor: number;
  remainingMinor: number;
  historicalAsOf: string;
  openingEffect: "none" | "created" | "increased";
  openingHistoryId: number | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  status: "live" | "void";
  voidedBy: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

interface AgreementRow {
  id: number; patient_id: number; plan_item_id: number; plan_id: number; case_id: number | null; case_title: string | null;
  service_id: number; service_name: string; specialty: string; tooth_code: number | null; currency: string;
  agreed_minor: string; previously_paid_minor: string; remaining_minor: string; historical_as_of: string;
  opening_effect: "none" | "created" | "increased"; opening_history_id: number | null; note: string | null;
  created_by: string; created_at: Date; status: "live" | "void"; voided_by: string | null; voided_at: Date | null;
  void_reason: string | null;
}

const AGREEMENT_SELECT = `
  SELECT a.id, a.patient_id, a.plan_item_id, i.plan_id, a.case_id, c.title AS case_title, a.service_id, a.service_name,
         a.specialty, a.tooth_code, a.currency, a.agreed_minor::text, a.previously_paid_minor::text,
         a.remaining_minor::text, a.historical_as_of::text, a.opening_effect, a.opening_history_id, a.note,
         a.created_by, a.created_at, a.status, a.voided_by, a.voided_at, a.void_reason
    FROM legacy_treatment_agreements a
    JOIN plan_items i ON i.id = a.plan_item_id
    LEFT JOIN clinical_cases c ON c.id = a.case_id`;

function toView(row: AgreementRow): LegacyAgreementView {
  if (!isCurrency(row.currency)) throw new Error(`عملة اتفاق تاريخي غير صالحة: ${row.currency}`);
  return {
    id: row.id, patientId: row.patient_id, planItemId: row.plan_item_id, planId: row.plan_id,
    caseId: row.case_id, caseTitle: row.case_title, serviceId: row.service_id, serviceName: row.service_name,
    specialty: row.specialty,
    specialtyLabel: (LINKAGE_SPECIALTY_LABEL as Record<string, string>)[row.specialty] ?? row.specialty,
    toothCode: row.tooth_code, currency: row.currency,
    agreedMinor: Number(row.agreed_minor), previouslyPaidMinor: Number(row.previously_paid_minor),
    remainingMinor: Number(row.remaining_minor), historicalAsOf: row.historical_as_of,
    openingEffect: row.opening_effect, openingHistoryId: row.opening_history_id, note: row.note,
    createdBy: row.created_by, createdAt: row.created_at.toISOString(), status: row.status,
    voidedBy: row.voided_by, voidedAt: row.voided_at?.toISOString() ?? null, voidReason: row.void_reason,
  };
}

export async function listLegacyTreatments(patientId: number): Promise<LegacyAgreementView[]> {
  await ensureSchema();
  const { rows } = await getPool().query<AgreementRow>(
    `${AGREEMENT_SELECT} WHERE a.patient_id = $1 ORDER BY (a.status = 'live') DESC, a.id DESC`, [patientId]);
  return rows.map(toView);
}

async function readAgreement(id: number): Promise<LegacyAgreementView> {
  const { rows: [row] } = await getPool().query<AgreementRow>(`${AGREEMENT_SELECT} WHERE a.id = $1`, [id]);
  return toView(row);
}

class Refusal extends Error {
  constructor(readonly reason: LegacyTreatmentRefusal | LegacyVoidRefusal) { super(reason); }
}

async function audit(client: DbClient, entry: AuditInput) { await insertAuditRow(client, entry); }

/** الرصيد السابق بهذه العملة «ملك الاتفاقات» إن كان أصله مجموعَ متبقيات الاتفاقات الحيّة التي أنشأته أو زادته بالضبط. */
async function liveAgreementRemaining(client: DbClient, patientId: number, currency: Currency): Promise<number> {
  const { rows: [row] } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(remaining_minor), 0)::text AS total FROM legacy_treatment_agreements
      WHERE patient_id = $1 AND currency = $2 AND status = 'live' AND opening_effect <> 'none'`,
    [patientId, currency]);
  return Number(row.total);
}

async function lockedOpening(client: DbClient, patientId: number, currency: Currency) {
  const { rows: [row] } = await client.query<{ amount_minor: string; as_of_date: string; note: string | null }>(
    `SELECT amount_minor::text, as_of_date::text, note FROM patient_opening_balances
      WHERE patient_id = $1 AND currency = $2 FOR UPDATE`, [patientId, currency]);
  return row ? { amountMinor: Number(row.amount_minor), asOfDate: row.as_of_date, note: row.note } : null;
}

export type CreateLegacyTreatmentResult =
  | { ok: true; replayed: boolean; agreement: LegacyAgreementView; caseCreated: boolean }
  | { ok: false; reason: LegacyTreatmentRefusal };

export async function createLegacyTreatment(input: {
  patientId: number;
  request: LegacyTreatmentRequest;
  actor: string;
  actorRole: string | null;
  /** من يملك تعديل الرصيد السابق (المدير): يضيف المتبقي إلى رصيدٍ أنشأته اتفاقاتٌ سابقة. وغيره يُنشئ فقط. */
  canEditOpening: boolean;
  templates: readonly SpecialtyTemplate[];
}): Promise<CreateLegacyTreatmentResult> {
  await ensureSchema();
  const written = await writeLegacyTreatment(input);
  if (!written.ok) return written;
  return { ok: true, replayed: written.replayed, caseCreated: written.caseCreated, agreement: await readAgreement(written.id) };
}

async function writeLegacyTreatment(input: Parameters<typeof createLegacyTreatment>[0]):
  Promise<{ ok: true; id: number; replayed: boolean; caseCreated: boolean } | { ok: false; reason: LegacyTreatmentRefusal }> {
  const { patientId, request } = input;
  const requestHash = request.idempotencyKey ? legacyTreatmentFingerprint(patientId, request) : null;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    /* سياج المريض نفسه الذي يأخذه كاتب الرصيد السابق بالإضافة (FOR UPDATE): يسلسل طلبين متزامنين، والفاتورة
       العلاجية، وإضافة رصيدٍ سابق من شاشةٍ أخرى. */
    const { rows: [patient] } = await client.query(`SELECT id FROM patients WHERE id = $1 FOR UPDATE`, [patientId]);
    if (!patient) throw new Refusal("no_patient");

    if (request.idempotencyKey) {
      const { rows: [prior] } = await client.query<{ id: number; idempotency_request_hash: string | null; patient_id: number }>(
        `SELECT id, idempotency_request_hash, patient_id FROM legacy_treatment_agreements WHERE idempotency_key = $1`,
        [request.idempotencyKey]);
      if (prior) {
        if (prior.idempotency_request_hash !== requestHash || prior.patient_id !== patientId) {
          throw new Refusal("idempotency_conflict");
        }
        await client.query("ROLLBACK");
        return { ok: true, id: prior.id, replayed: true, caseCreated: false };
      }
    }

    const { rows: [service] } = await client.query<{ id: number; name: string; category: string | null }>(
      `SELECT id, name, category FROM services WHERE id = $1 AND is_active = TRUE`, [request.serviceId]);
    const linkage = service ? lineLinkage({ serviceId: service.id, category: service.category }) : { kind: "financial" as const };
    if (!service || linkage.kind !== "clinical") throw new Refusal("bad_service");
    /* (INV-LINK TOOTH) القاعدة نفسها التي تحكم بند الفاتورة: خدمةٌ تخص سنًّا بلا سن لا تُسجَّل (fail closed). */
    const checked = validateLineSite({
      category: service.category, toothCode: request.toothCode, surfaces: request.surfaces,
      episodeTeeth: request.episodeTeeth, scope: request.scope,
    });
    if (!checked.ok) throw new Refusal(checked.reason as LegacyTreatmentRefusal);
    const site = checked.site;

    /* لا اتفاقان حيّان للعمل نفسه، ولا اتفاقٌ تاريخي فوق بند خطةٍ مفتوح للعمل نفسه (مفوترٍ أو مخطَّط في النظام). */
    const { rows: [duplicate] } = await client.query(
      `SELECT 1 FROM legacy_treatment_agreements
        WHERE patient_id = $1 AND service_id = $2 AND tooth_code IS NOT DISTINCT FROM $3::smallint AND status = 'live'`,
      [patientId, service.id, site.toothCode]);
    if (duplicate) throw new Refusal("duplicate_live");
    const { rows: [openItem] } = await client.query(
      `SELECT 1 FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
        WHERE t.patient_id = $1 AND t.status = 'active' AND i.service_id = $2
          AND i.tooth_code IS NOT DISTINCT FROM $3::smallint AND i.status IN ('planned', 'in_progress')`,
      [patientId, service.id, site.toothCode]);
    if (openItem) throw new Refusal("open_item_exists");

    const amounts = `المتفق ${formatMoney(request.agreedMinor, request.currency)} · المدفوع قبل النظام `
      + `${formatMoney(request.previouslyPaidMinor, request.currency)} · المتبقي ${formatMoney(request.remainingMinor, request.currency)}`;

    // ── الرصيد السابق: المتبقي وحده، بمحرّك الرصيد الافتتاحي نفسه ──
    let openingEffect: "none" | "created" | "increased" = "none";
    let openingHistoryId: number | null = null;
    let openingBefore: { amountMinor: number; asOfDate: string } | null = null;
    let openingAfter: { amountMinor: number; asOfDate: string } | null = null;
    if (request.remainingMinor > 0) {
      const existing = await lockedOpening(client, patientId, request.currency);
      if (existing) {
        /* رصيدٌ قائم: يُضاف إليه فقط إن كان كلّه متبقيات اتفاقاتٍ حيّة (لا رصيدٌ يدوي قد يشمل هذا العلاج فيُحسب مرتين)،
           والإضافة إلى رصيدٍ قائم تعديلٌ — للمدير وحده كما في المحرّك. */
        if (existing.amountMinor !== await liveAgreementRemaining(client, patientId, request.currency)) {
          throw new Refusal("opening_not_owned");
        }
        if (!input.canEditOpening) throw new Refusal("opening_edit_forbidden");
        const asOfDate = existing.asOfDate < request.historicalAsOf ? existing.asOfDate : request.historicalAsOf;
        if (await isPeriodLocked(existing.asOfDate) || await isPeriodLocked(asOfDate)) throw new Refusal("period_locked");
        openingBefore = { amountMinor: existing.amountMinor, asOfDate: existing.asOfDate };
        openingAfter = { amountMinor: existing.amountMinor + request.remainingMinor, asOfDate };
        const saved = await setPatientOpeningBalanceInTx(client, {
          patientId, currency: request.currency, amountMinor: openingAfter.amountMinor, asOfDate,
          note: existing.note, createdBy: input.actor, addOnly: false, expectedBefore: openingBefore,
          reason: `إضافة متبقي علاجٍ بدأ قبل النظام — ${service.name}: ${amounts}`,
        });
        if (!saved) throw new Refusal("no_patient");
        openingEffect = "increased";
        openingHistoryId = saved.historyId;
      } else {
        if (await isPeriodLocked(request.historicalAsOf)) throw new Refusal("period_locked");
        openingAfter = { amountMinor: request.remainingMinor, asOfDate: request.historicalAsOf };
        const saved = await setPatientOpeningBalanceInTx(client, {
          patientId, currency: request.currency, amountMinor: request.remainingMinor, asOfDate: request.historicalAsOf,
          note: `متبقي علاجٍ بدأ قبل النظام — ${service.name}: ${amounts}`, createdBy: input.actor,
          addOnly: !input.canEditOpening, expectedBefore: null,
        });
        if (!saved) throw new Refusal("no_patient");
        openingEffect = "created";
        openingHistoryId = saved.historyId;
      }
    }

    // ── بند الخطة: هوية العمل، في خطةٍ للاتفاق التاريخي، موافَقٌ عليها به، ومغطّى ──
    const specialty = linkage.specialty;
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const where = siteText(site);
    const planTitle = `علاج بدأ قبل النظام — ${service.name}${where ? ` — ${site.toothCode !== null && !site.episodeTeeth?.[1] ? `سن ${where}` : where}` : ""}`;
    const plan = await insertPlanV2InTx(client, {
      patientId, title: planTitle, specialty, primaryDoctorId: null, billingMode: "per_procedure",
      baseCurrency: request.currency, startDate: request.historicalAsOf <= today ? request.historicalAsOf : today,
      note: `اتفاق تاريخي حتى ${request.historicalAsOf}: ${amounts}. لا يُفوتر — المتبقي في الرصيد السابق.`,
      items: [{
        serviceId: service.id, serviceName: service.name, category: service.category, toothCode: site.toothCode,
        surfaces: site.surfaces, quantity: 1, unitPriceMinor: request.agreedMinor, billingRule: "on_completion" as const,
        sessionCount: sessionsFor(service.category, request.sessions, input.templates),
        note: scopeNote(site) ?? (site.episodeTeeth && site.episodeTeeth.length > 1 ? `الأسنان: ${site.episodeTeeth.join("، ")}` : null),
      }],
      installments: [],
      createdBy: input.actor,
    });
    if (!plan.ok) throw new Error(plan.message);
    const itemId = plan.itemIds[0];
    await client.query(
      `UPDATE treatment_plans SET consent_at = NOW(), consent_by = $2, consent_note = $3 WHERE id = $1`,
      [plan.planId, input.actor, `اتفاق تاريخي قبل النظام (حتى ${request.historicalAsOf}) — مسجَّل من حساب المريض؛ لا يُفوتر`]);
    await client.query(`UPDATE plan_items SET billing_status = 'included_in_package' WHERE id = $1`, [itemId]);
    await audit(client, {
      action: "plan.create", entity: "patient", entityId: patientId, entityLabel: planTitle,
      details: { الخطة: plan.planId, البنود: 1, المصدر: "علاج بدأ قبل النظام", الموافقة: "اتفاق تاريخي", التغطية: "مشمول بالاتفاق التاريخي" },
      actor: input.actor, actorRole: input.actorRole,
    });

    // ── الحالة التخصصية: المفتوحة الموافقة تُعاد، أو تُجسَر حالة التقويم القائمة، أو تُفتح حالةٌ موسومة ──
    let caseId: number | null = null;
    let caseCreated = false;
    if (linkage.needsCase) {
      if (request.caseId !== null) {
        const { rows: [chosen] } = await client.query<{ id: number }>(
          `SELECT id FROM clinical_cases WHERE id = $1 AND patient_id = $2 AND specialty = $3 AND status IN ('active', 'waiting')
            FOR UPDATE`, [request.caseId, patientId, specialty]);
        if (!chosen) throw new Refusal("bad_case");
        caseId = chosen.id;
      } else {
        const { rows: sameSpecialty } = await client.query<{ id: number; site: string | null }>(
          `SELECT id, site FROM clinical_cases WHERE patient_id = $1 AND specialty = $2 AND status IN ('active', 'waiting')
            ORDER BY id FOR UPDATE`, [patientId, specialty]);
        const open = sameSpecialty.filter((row) => caseSiteFits(specialty, row.site, site));
        if (open.length > 1) throw new Refusal("ambiguous_case");
        if (open.length === 1) {
          caseId = open[0].id;
        } else {
          let orthoCaseId: number | null = null;
          if (specialty === "orthodontics") {
            const { rows: [ortho] } = await client.query<{ id: number }>(
              `SELECT o.id FROM ortho_cases o
                WHERE o.patient_id = $1 AND o.status IN ('active', 'retention')
                  AND NOT EXISTS (SELECT 1 FROM clinical_cases cc WHERE cc.ortho_case_id = o.id)
                ORDER BY o.id DESC LIMIT 1`, [patientId]);
            orthoCaseId = ortho?.id ?? null;
          }
          const title = orthoCaseId !== null ? "تقويم الأسنان" : legacyCaseTitle(specialty, site);
          const { rows: [created] } = await client.query<{ id: number }>(
            `INSERT INTO clinical_cases (patient_id, specialty, title, site, ortho_case_id, created_by, origin)
             VALUES ($1, $2, $3, $4::text, $5::int, $6, 'clinical') RETURNING id`,
            [patientId, specialty, title, siteText(site), orthoCaseId, input.actor]);
          caseId = created.id;
          caseCreated = true;
          await audit(client, {
            action: "case.create", entity: "patient", entityId: patientId, entityLabel: title,
            details: {
              الحالة: caseId, التخصص: LINKAGE_SPECIALTY_LABEL[specialty], المصدر: "علاج بدأ قبل النظام",
              جسر_التقويم: orthoCaseId ?? "—", وضع_الحالة: "حالة بدأت قبل النظام",
            },
            actor: input.actor, actorRole: input.actorRole,
          });
        }
      }
      await client.query(`UPDATE plan_items SET case_id = $2 WHERE id = $1`, [itemId, caseId]);
      await audit(client, {
        action: "plan.item_case", entity: "patient", entityId: patientId, entityLabel: service.name,
        details: { البند: itemId, الحالة: caseId, المصدر: "علاج بدأ قبل النظام" },
        actor: input.actor, actorRole: input.actorRole,
      });
    }

    const { rows: [agreement] } = await client.query<{ id: number }>(
      `INSERT INTO legacy_treatment_agreements
         (patient_id, plan_item_id, case_id, service_id, service_name, specialty, tooth_code, currency, agreed_minor,
          previously_paid_minor, remaining_minor, historical_as_of, opening_effect, opening_history_id, note,
          idempotency_key, idempotency_request_hash, created_by)
       VALUES ($1, $2, $3::int, $4, $5, $6, $7::smallint, $8, $9, $10, $11, $12::date, $13, $14::int, $15::text,
               $16::text, $17::text, $18)
       RETURNING id`,
      [patientId, itemId, caseId, service.id, service.name, specialty, site.toothCode, request.currency,
        request.agreedMinor, request.previouslyPaidMinor, request.remainingMinor, request.historicalAsOf, openingEffect,
        openingHistoryId, request.note, request.idempotencyKey, requestHash, input.actor]);

    if (openingAfter) {
      await audit(client, {
        action: "opening_balance.set", entity: "patient", entityId: patientId, entityLabel: service.name,
        details: {
          المبلغ: openingAfter.amountMinor, العملة: request.currency, التاريخ: openingAfter.asOfDate,
          ...(openingBefore ? { المبلغ_السابق: openingBefore.amountMinor, التاريخ_السابق: openingBefore.asOfDate } : {}),
          المصدر: `اتفاق علاج بدأ قبل النظام #${agreement.id}`,
        },
        actor: input.actor, actorRole: input.actorRole,
      });
    }
    await audit(client, {
      action: "legacy_treatment.create", entity: "patient", entityId: patientId, entityLabel: service.name,
      details: {
        الاتفاق: agreement.id, التخصص: LINKAGE_SPECIALTY_LABEL[specialty], السن: siteText(site) ?? "—",
        العملة: request.currency, المتفق: request.agreedMinor, المدفوع_قبل_النظام: request.previouslyPaidMinor,
        المتبقي: request.remainingMinor, حتى_تاريخ: request.historicalAsOf, البند: itemId, الحالة: caseId ?? "—",
        الرصيد_السابق: openingEffect === "none" ? "لا رصيد (مسدَّد تاريخيًّا)" : openingEffect === "created" ? "أُنشئ بالمتبقي" : "أُضيف إليه المتبقي",
        سند: "لا سند للمدفوع سابقًا",
      },
      actor: input.actor, actorRole: input.actorRole,
    });
    await client.query("COMMIT");
    return { ok: true, id: agreement.id, replayed: false, caseCreated };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Refusal) return { ok: false, reason: error.reason as LegacyTreatmentRefusal };
    if (error instanceof OpeningBalanceExists) return { ok: false, reason: "opening_edit_forbidden" };
    if (error instanceof OpeningBalanceChanged) return { ok: false, reason: "opening_changed" };
    const constraint = (error as { code?: string; constraint?: string });
    if (constraint.code === "23505" && constraint.constraint === "legacy_treatment_agreements_idempotency_uniq") {
      return { ok: false, reason: "idempotency_conflict" };
    }
    if (constraint.code === "23505" && constraint.constraint === "legacy_treatment_agreements_live_scope_uniq") {
      return { ok: false, reason: "duplicate_live" };
    }
    throw error;
  } finally {
    client.release();
  }
}

export type VoidLegacyTreatmentResult =
  | { ok: true; agreement: LegacyAgreementView }
  | { ok: false; reason: LegacyVoidRefusal };

/**
 * إبطال الاتفاق (للمدير، بسبب): التغطية تُحرَّر (البند يعود «غير مفوتر» كإلغاء الفاتورة)، والرصيد السابق يُصحَّح بمسار
 * المحرّك نفسه — يُنقص المتبقي أو يُمسح بسطر سجلّه — ما لم يكن سُدِّد منه ما لا يبقى مغطًّى؛ والبند الذي لم تُنجز له جلسة
 * تُلغى خطته (أُنشئت للاتفاق وحده). لا حذف ولا مسّ للسجل السريري.
 */
export async function voidLegacyTreatment(input: {
  patientId: number; agreementId: number; reason: string; actor: string; actorRole: string | null;
}): Promise<VoidLegacyTreatmentResult> {
  await ensureSchema();
  const reason = input.reason.trim().slice(0, 300);
  if (reason.length < 3) return { ok: false, reason: "bad_reason" };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: [found] } = await client.query<{ plan_item_id: number }>(
      `SELECT plan_item_id FROM legacy_treatment_agreements WHERE id = $1 AND patient_id = $2`,
      [input.agreementId, input.patientId]);
    if (!found) throw new Refusal("not_found");
    /* ترتيب الأقفال كالتوقيع: البند ثم الاتفاق، ثم المريض بقفلٍ يتوافق مع مفاتيح الدفعات (NO KEY UPDATE). */
    const { rows: [item] } = await client.query<{ id: number; plan_id: number; status: string; service_name: string; done: string }>(
      `SELECT i.id, i.plan_id, i.status, i.service_name,
              (SELECT COUNT(*) FROM treatment_sessions s WHERE s.plan_item_id = i.id AND s.status = 'done')::text AS done
         FROM plan_items i WHERE i.id = $1 FOR UPDATE OF i`, [found.plan_item_id]);
    const { rows: [agreement] } = await client.query<{
      status: string; currency: string; remaining_minor: string; opening_effect: string; service_name: string;
    }>(
      `SELECT status, currency, remaining_minor::text, opening_effect, service_name
         FROM legacy_treatment_agreements WHERE id = $1 FOR UPDATE`, [input.agreementId]);
    if (agreement.status !== "live") throw new Refusal("already_void");
    await client.query(`SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE`, [input.patientId]);
    const currency = agreement.currency as Currency;
    const remaining = Number(agreement.remaining_minor);

    let voidHistoryId: number | null = null;
    let openingAudit: AuditInput | null = null;
    if (agreement.opening_effect !== "none") {
      const existing = await lockedOpening(client, input.patientId, currency);
      /* الرصيد يجب أن يبقى كما بنته الاتفاقات الحيّة — تعديلٌ يدوي بعدها يحتاج مراجعة المدير لا طرحًا أعمى. */
      if (!existing || existing.amountMinor !== await liveAgreementRemaining(client, input.patientId, currency)
        || existing.amountMinor < remaining) {
        throw new Refusal("opening_changed");
      }
      const position = await openingPosition(client, input.patientId, currency);
      const after = existing.amountMinor - remaining;
      if (after < (position?.settledMinor ?? 0)) throw new Refusal("opening_settled");
      if (await isPeriodLocked(existing.asOfDate)) throw new Refusal("period_locked");
      const why = `إبطال اتفاق علاجٍ بدأ قبل النظام #${input.agreementId} — ${agreement.service_name}: ${reason}`;
      const expectedBefore = { amountMinor: existing.amountMinor, asOfDate: existing.asOfDate };
      if (after === 0) {
        voidHistoryId = await clearPatientOpeningBalanceInTx(client, input.patientId, input.actor, why, currency, expectedBefore);
        openingAudit = {
          action: "opening_balance.clear", entity: "patient", entityId: input.patientId, entityLabel: agreement.service_name,
          details: { المبلغ_المحذوف: existing.amountMinor, العملة: currency, التاريخ: existing.asOfDate, السبب: why },
          actor: input.actor, actorRole: input.actorRole,
        };
      } else {
        const saved = await setPatientOpeningBalanceInTx(client, {
          patientId: input.patientId, currency, amountMinor: after, asOfDate: existing.asOfDate, note: existing.note,
          createdBy: input.actor, reason: why, addOnly: false, expectedBefore,
        });
        voidHistoryId = saved?.historyId ?? null;
        openingAudit = {
          action: "opening_balance.set", entity: "patient", entityId: input.patientId, entityLabel: agreement.service_name,
          details: { المبلغ: after, العملة: currency, التاريخ: existing.asOfDate, المبلغ_السابق: existing.amountMinor,
            التاريخ_السابق: existing.asOfDate, السبب: why },
          actor: input.actor, actorRole: input.actorRole,
        };
      }
      if (voidHistoryId === null) throw new Refusal("opening_changed");
    }

    await client.query(
      `UPDATE legacy_treatment_agreements
          SET status = 'void', voided_by = $2, voided_at = NOW(), void_reason = $3, void_opening_history_id = $4::int
        WHERE id = $1`, [input.agreementId, input.actor, reason, voidHistoryId]);
    await client.query(
      `UPDATE plan_items SET billing_status = 'unbilled' WHERE id = $1 AND billing_status = 'included_in_package'`, [item.id]);
    await audit(client, {
      action: "plan.item_update", entity: "patient", entityId: input.patientId, entityLabel: item.service_name,
      details: { البند: item.id, الرابط_المالي: "أُبطل الاتفاق التاريخي — يحتاج مراجعة مالية", الاتفاق: input.agreementId },
      actor: input.actor, actorRole: input.actorRole,
    });
    /* البند لم تُنجز له جلسة: خطته (أُنشئت لهذا الاتفاق وحده) تُلغى بسببٍ مكتوب، فيُعاد تسجيل العلاج صحيحًا إن لزم.
       وإن بدأ العلاج في النظام بقي البند في خطته (التاريخ السريري لا يُمسّ) ويُفوتر ما بعده بقاعدته. */
    if (Number(item.done) === 0 && item.status === "planned") {
      const { rows: [planRow] } = await client.query<{ status: string; title: string }>(
        `SELECT status, title FROM treatment_plans WHERE id = $1 FOR UPDATE`, [item.plan_id]);
      if (planRow?.status === "active") {
        await client.query(`UPDATE treatment_plans SET status = 'cancelled' WHERE id = $1`, [item.plan_id]);
        await audit(client, {
          action: "plan.status", entity: "treatment_plans", entityId: item.plan_id, entityLabel: planRow.title,
          details: { من: "active", إلى: "cancelled", السبب: `إبطال اتفاق علاجٍ بدأ قبل النظام: ${reason}` },
          actor: input.actor, actorRole: input.actorRole,
        });
      }
    }
    if (openingAudit) await audit(client, openingAudit);
    await audit(client, {
      action: "legacy_treatment.void", entity: "patient", entityId: input.patientId, entityLabel: agreement.service_name,
      details: {
        الاتفاق: input.agreementId, السبب: reason, العملة: currency, المتبقي_المُزال: agreement.opening_effect === "none" ? 0 : remaining,
        التغطية: "حُرِّرت", السجل_السريري: "محفوظ",
      },
      actor: input.actor, actorRole: input.actorRole,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Refusal) return { ok: false, reason: error.reason as LegacyVoidRefusal };
    if (error instanceof OpeningBalanceChanged) return { ok: false, reason: "opening_changed" };
    throw error;
  } finally {
    client.release();
  }
  return { ok: true, agreement: await readAgreement(input.agreementId) };
}
