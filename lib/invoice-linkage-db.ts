/**
 * (INV-LINK B) الفاتورة العلاجية ← بند الخطة ← الحالة التخصصية، في معاملةٍ واحدة.
 *
 * - البند العلاجي (خدمة دليل بفئةٍ علاجية) يرتبط ببند خطة: يُعاد استعمال بندٍ مفتوحٍ مطابق تمامًا إن وُجد،
 *   وإلا تُنشأ خطةٌ واحدة لكل فاتورة لبنودها الجديدة (بالقلب نفسه الذي ينشئ الخطط `insertPlanV2InTx`).
 * - البند المالي (بلا خدمة، أو كشف/أشعة/فئة مجهولة) يبقى فاتورةً فقط — لا يُستنتج تخصصٌ من نص.
 * - سطر الفاتورة يحمل `source_type='plan_item'` (الفهرس الفريد القائم يمنع فوترة البند مرتين)،
 *   والبند يحمل `billed_invoice_id` (رابطه المالي الحي) و`origin='invoice'`.
 * - الحالة: تُعاد الحالة المفتوحة الوحيدة للتخصص، أو تُنشأ حالةٌ أولية «تحتاج تقييمًا سريريًّا» بلا أي تفاصيل
 *   سريرية، أو يُرفض الطلب إن تعدّدت الحالات بلا اختيار. لا ortho_cases، لا نتائج عصب، لا طلب مختبر.
 * - قفل صف المريض يسلسل الطلبات المتزامنة؛ ومفتاح الإعادة يعيد الفاتورة نفسها لا فاتورةً ثانية.
 * التصميم: docs/INVOICE_FIRST_CLINICAL_LINKAGE.md.
 */
import {
  CLINIC_TIME_ZONE, ensureSchema, getInvoice, getPool, insertAuditRow, insertPlanV2InTx,
  type AuditInput, type DbClient, type Invoice,
} from "./db";
import { documentNumberSql } from "./document-numbers";
import { isValidTooth } from "./dental";
import type { Currency } from "./money";
import { clinicDateString } from "./schedule";
import type { SpecialtyTemplate } from "./specialty-templates";
import {
  LINKAGE_SPECIALTY_LABEL, lineLinkage, sessionsFor, shellCaseTitle,
  type InvoiceLinkageRefusal, type LinkageSpecialty,
} from "./invoice-clinical-linkage";

export interface LinkedInvoiceLineInput {
  serviceId: number | null;
  category: string | null;
  doctorId: number | null;
  description: string;
  quantity: number;
  unitPriceMinor: number;
  toothCode: number | null;
  /** حالةٌ يختارها المستخدم لهذا البند (حين للمريض أكثر من حالة مفتوحة للتخصص). */
  caseId: number | null;
  /** عدد جلسات البند إن أُعطي؛ وإلا من قالب التخصص. */
  sessions: number | null;
}

export interface LineLink {
  line: number;
  kind: "financial" | "clinical";
  specialty: LinkageSpecialty | null;
  planItemId: number | null;
  planItemCreated: boolean;
  caseId: number | null;
  caseCreated: boolean;
}

export type CreateLinkedInvoiceResult =
  | { ok: true; invoice: Invoice; replayed: boolean; planId: number | null; links: LineLink[] }
  | { ok: false; reason: InvoiceLinkageRefusal | "no_patient"; line: number | null };

class Refusal extends Error {
  constructor(readonly reason: InvoiceLinkageRefusal | "no_patient", readonly line: number | null) { super(reason); }
}

const OPEN_CASE = `status IN ('active', 'waiting')`;

async function audit(client: DbClient, entry: AuditInput) { await insertAuditRow(client, entry); }

/** روابط فاتورةٍ قائمة كما كُتبت — لإعادة الطلب نفسه بلا أثرٍ ثانٍ. */
async function existingLinks(client: Pick<DbClient, "query">, invoiceId: number): Promise<{ planId: number | null; links: LineLink[] }> {
  const { rows } = await client.query<{
    source_id: string | null; case_id: number | null; plan_id: number | null; specialty: string | null;
  }>(
    `SELECT ii.source_id::text, i.case_id, i.plan_id, c.specialty
       FROM invoice_items ii
       LEFT JOIN plan_items i ON ii.source_type = 'plan_item' AND i.id = ii.source_id
       LEFT JOIN clinical_cases c ON c.id = i.case_id
      WHERE ii.invoice_id = $1 ORDER BY ii.id`, [invoiceId]);
  let planId: number | null = null;
  const links = rows.map((row, line) => {
    planId = planId ?? row.plan_id;
    return {
      line, kind: row.source_id === null ? "financial" as const : "clinical" as const,
      specialty: (row.specialty as LinkageSpecialty | null) ?? null,
      planItemId: row.source_id === null ? null : Number(row.source_id), planItemCreated: false,
      caseId: row.case_id, caseCreated: false,
    };
  });
  return { planId, links };
}

export async function createLinkedInvoice(input: {
  patientId: number;
  baseCurrency: Currency;
  discountMinor: number;
  note: string | null;
  createdBy: string;
  actorRole: string | null;
  items: LinkedInvoiceLineInput[];
  templates: readonly SpecialtyTemplate[];
  idempotencyKey: string | null;
  requestHash: string | null;
  /** تفاصيل سطر تدقيق `invoice.create` (السلطة السعرية) — يُكتب داخل المعاملة نفسها. */
  auditDetails: Record<string, unknown>;
}): Promise<CreateLinkedInvoiceResult> {
  await ensureSchema();
  /* القراءة النهائية بعد تحرير اتصال المعاملة: إمساكُ اتصالٍ وطلبُ آخر تحت التزامن يستنفد المجمّع. */
  const written = await writeLinkedInvoice(input);
  if (!written.ok) return written;
  const invoice = await getInvoice(written.invoiceId);
  return { ok: true, invoice: invoice as Invoice, replayed: written.replayed, planId: written.planId, links: written.links };
}

type Written =
  | { ok: true; invoiceId: number; replayed: boolean; planId: number | null; links: LineLink[] }
  | Extract<CreateLinkedInvoiceResult, { ok: false }>;

async function writeLinkedInvoice(input: Parameters<typeof createLinkedInvoice>[0]): Promise<Written> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: patient } = await client.query(`SELECT id FROM patients WHERE id = $1 FOR UPDATE`, [input.patientId]);
    if (!patient[0]) throw new Refusal("no_patient", null);

    if (input.idempotencyKey) {
      const { rows: [prior] } = await client.query<{ id: number; idempotency_request_hash: string | null; patient_id: number }>(
        `SELECT id, idempotency_request_hash, patient_id FROM invoices WHERE idempotency_key = $1`, [input.idempotencyKey]);
      if (prior) {
        if (prior.idempotency_request_hash !== input.requestHash || prior.patient_id !== input.patientId) {
          throw new Refusal("idempotency_conflict", null);
        }
        const replay = await existingLinks(client, prior.id);
        await client.query("ROLLBACK");
        return { ok: true, invoiceId: prior.id, replayed: true, ...replay };
      }
    }

    const linkages = input.items.map((item) => lineLinkage({ serviceId: item.serviceId, category: item.category }));
    input.items.forEach((item, line) => {
      if (linkages[line].kind === "clinical" && item.toothCode !== null && !isValidTooth(item.toothCode)) {
        throw new Refusal("bad_tooth", line);
      }
    });

    const total = input.items.reduce((sum, item) => sum + Math.max(0, item.quantity) * Math.max(0, item.unitPriceMinor), 0);
    const discount = Math.min(Math.max(0, input.discountMinor), total);
    const { rows: [created] } = await client.query<{ id: number; invoice_number: string }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, note, created_by,
                             idempotency_key, idempotency_request_hash)
       VALUES (${documentNumberSql("invoice")}, $1, $2, $3, $4, $5::text, $6, $7::text, $8::text)
       RETURNING id, invoice_number`,
      [input.patientId, total, discount, input.baseCurrency, input.note, input.createdBy,
        input.idempotencyKey, input.idempotencyKey ? input.requestHash : null]);
    const invoiceId = created.id;

    // ── بنود الخطة: مطابقٌ مفتوح يُعاد، وإلا جديدٌ في خطةٍ واحدة لهذه الفاتورة ──
    const links: LineLink[] = input.items.map((_, line) => ({
      line, kind: linkages[line].kind, specialty: linkages[line].kind === "clinical" ? (linkages[line] as { specialty: LinkageSpecialty }).specialty : null,
      planItemId: null, planItemCreated: false, caseId: null, caseCreated: false,
    }));
    const claimed: number[] = [];
    const fresh: number[] = [];
    for (const [line, item] of input.items.entries()) {
      if (linkages[line].kind !== "clinical") continue;
      /* العمل نفسه مفوترٌ مسبقًا بفاتورةٍ حيّة ولم يبدأ: تبويبان أو نقرتان بمفتاحين ⇒ رفضٌ لا التزامٌ ثانٍ. */
      const { rows: [billed] } = await client.query(
        `SELECT 1 FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id JOIN invoices v ON v.id = i.billed_invoice_id
          WHERE t.patient_id = $1 AND i.service_id = $2 AND i.tooth_code IS NOT DISTINCT FROM $3::smallint
            AND i.billing_status = 'billed' AND v.status <> 'cancelled' AND i.status = 'planned' AND i.started_at IS NULL
          LIMIT 1`, [input.patientId, item.serviceId, item.toothCode]);
      if (billed) throw new Refusal("already_billed", line);
      const { rows: [match] } = await client.query<{ id: number; quantity: number; unit_price_minor: string; case_id: number | null }>(
        `SELECT i.id, i.quantity, i.unit_price_minor, i.case_id
           FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
          WHERE t.patient_id = $1 AND t.status = 'active' AND t.consent_at IS NOT NULL AND t.base_currency = $2
            AND NOT EXISTS (SELECT 1 FROM plan_installments pi WHERE pi.plan_id = t.id)
            AND i.service_id = $3 AND i.tooth_code IS NOT DISTINCT FROM $4::smallint
            AND i.status = 'planned' AND i.billing_status = 'unbilled' AND i.started_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM treatment_sessions s WHERE s.plan_item_id = i.id AND s.status = 'done')
            AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.source_type = 'plan_item' AND ii.source_id = i.id)
            AND i.id <> ALL($5::int[])
          ORDER BY i.id LIMIT 1
            FOR UPDATE OF i`,
        [input.patientId, input.baseCurrency, item.serviceId, item.toothCode, claimed]);
      if (!match) { fresh.push(line); continue; }
      if (match.quantity * Number(match.unit_price_minor) !== Math.max(1, Math.round(item.quantity)) * Math.round(item.unitPriceMinor)) {
        throw new Refusal("amount_mismatch", line);
      }
      claimed.push(match.id);
      links[line].planItemId = match.id;
      links[line].caseId = match.case_id;
      await client.query(
        `UPDATE plan_items SET billing_status = 'billed', billed_invoice_id = $2 WHERE id = $1`, [match.id, invoiceId]);
      await audit(client, {
        action: "plan.item_update", entity: "patient", entityId: input.patientId, entityLabel: item.description,
        details: { البند: match.id, الرابط_المالي: `قُبل ماليًّا بالفاتورة ${created.invoice_number}`, المصدر: "فاتورة علاجية" },
        actor: input.createdBy, actorRole: input.actorRole,
      });
    }

    let planId: number | null = null;
    if (fresh.length > 0) {
      const specialties = [...new Set(fresh.map((line) => links[line].specialty))];
      const plan = await insertPlanV2InTx(client, {
        patientId: input.patientId,
        title: `علاج مفوتر — ${created.invoice_number}`,
        specialty: specialties.length === 1 ? specialties[0] : null,
        primaryDoctorId: null,
        billingMode: "per_procedure",
        baseCurrency: input.baseCurrency,
        startDate: clinicDateString(new Date(), CLINIC_TIME_ZONE),
        note: `أُنشئت من الفاتورة ${created.invoice_number}`,
        items: fresh.map((line) => {
          const item = input.items[line];
          return {
            serviceId: item.serviceId, serviceName: item.description, category: item.category,
            toothCode: item.toothCode, surfaces: null,
            quantity: Math.max(1, Math.round(item.quantity)), unitPriceMinor: Math.round(item.unitPriceMinor),
            billingRule: "on_completion" as const,
            sessionCount: sessionsFor(item.category, item.sessions, input.templates), note: null,
          };
        }),
        installments: [],
        createdBy: input.createdBy,
      });
      if (!plan.ok) throw new Error(plan.message);
      planId = plan.planId;
      /* القبول المالي بالفاتورة اتفاقٌ على هذه البنود بأسعارها — يُسجَّل صراحةً بمصدره، والتقييم السريري لدى الطبيب. */
      await client.query(
        `UPDATE treatment_plans SET consent_at = NOW(), consent_by = $2, consent_note = $3 WHERE id = $1`,
        [planId, input.createdBy, `قبول مالي بالفاتورة ${created.invoice_number} — التقييم السريري لدى الطبيب`]);
      for (const [index, line] of fresh.entries()) {
        const itemId = plan.itemIds[index];
        links[line].planItemId = itemId;
        links[line].planItemCreated = true;
        await client.query(
          `UPDATE plan_items
              SET billing_status = 'billed', billed_invoice_id = $2, origin = 'invoice', origin_invoice_id = $2,
                  doctor_id = COALESCE(doctor_id, $3::int)
            WHERE id = $1`,
          [itemId, invoiceId, input.items[line].doctorId]);
      }
      await audit(client, {
        action: "plan.create", entity: "patient", entityId: input.patientId, entityLabel: `علاج مفوتر — ${created.invoice_number}`,
        details: { الخطة: planId, البنود: fresh.length, المصدر: `فاتورة ${created.invoice_number}`, الموافقة: "قبول مالي بالفاتورة" },
        actor: input.createdBy, actorRole: input.actorRole,
      });
    }

    // ── الحالات التخصصية: حالةٌ مفتوحة واحدة تُعاد، أو أولية تُنشأ، أو رفضٌ إن تعدّدت بلا اختيار ──
    const caseBySpecialty = new Map<LinkageSpecialty, { id: number; created: boolean }>();
    for (const [line, item] of input.items.entries()) {
      const linkage = linkages[line];
      if (linkage.kind !== "clinical" || !linkage.needsCase) continue;
      const specialty = linkage.specialty;
      let caseId = links[line].caseId;
      let caseCreated = false;
      if (item.caseId !== null) {
        const { rows: [chosen] } = await client.query<{ id: number }>(
          `SELECT id FROM clinical_cases WHERE id = $1 AND patient_id = $2 AND specialty = $3 AND ${OPEN_CASE} FOR UPDATE`,
          [item.caseId, input.patientId, specialty]);
        if (!chosen) throw new Refusal("bad_case", line);
        caseId = chosen.id;
      } else if (caseId === null) {
        const known = caseBySpecialty.get(specialty);
        if (known) {
          caseId = known.id;
        } else {
          const { rows: open } = await client.query<{ id: number }>(
            `SELECT id FROM clinical_cases WHERE patient_id = $1 AND specialty = $2 AND ${OPEN_CASE} ORDER BY id FOR UPDATE`,
            [input.patientId, specialty]);
          if (open.length > 1) throw new Refusal("ambiguous_case", line);
          if (open.length === 1) {
            caseId = open[0].id;
          } else {
            // التقويم: حالة تقويمٍ جارية غير مجسورة تُجسَر — لا حالةٌ ثانية للمريض نفسه.
            let orthoCaseId: number | null = null;
            if (specialty === "orthodontics") {
              const { rows: [ortho] } = await client.query<{ id: number }>(
                `SELECT o.id FROM ortho_cases o
                  WHERE o.patient_id = $1 AND o.status IN ('active', 'retention')
                    AND NOT EXISTS (SELECT 1 FROM clinical_cases c WHERE c.ortho_case_id = o.id)
                  ORDER BY o.id DESC LIMIT 1`, [input.patientId]);
              orthoCaseId = ortho?.id ?? null;
            }
            const title = orthoCaseId !== null ? "تقويم الأسنان" : shellCaseTitle(specialty, item.toothCode);
            const { rows: [shell] } = await client.query<{ id: number }>(
              `INSERT INTO clinical_cases (patient_id, specialty, title, site, ortho_case_id, created_by, origin, origin_invoice_id)
               VALUES ($1, $2, $3, $4::text, $5::int, $6, 'invoice', $7) RETURNING id`,
              [input.patientId, specialty, title, item.toothCode !== null ? String(item.toothCode) : null, orthoCaseId,
                input.createdBy, invoiceId]);
            caseId = shell.id;
            caseCreated = true;
            await audit(client, {
              action: "case.create", entity: "patient", entityId: input.patientId, entityLabel: title,
              details: {
                الحالة: shell.id, التخصص: LINKAGE_SPECIALTY_LABEL[specialty], المصدر: `فاتورة ${created.invoice_number}`,
                جسر_التقويم: orthoCaseId ?? "—", وضع_الحالة: orthoCaseId !== null ? "حالة تقويم قائمة" : "تحتاج تقييمًا سريريًّا",
              },
              actor: input.createdBy, actorRole: input.actorRole,
            });
          }
          caseBySpecialty.set(specialty, { id: caseId, created: caseCreated });
        }
      }
      links[line].caseId = caseId;
      links[line].caseCreated = caseCreated;
      const { rowCount } = await client.query(
        `UPDATE plan_items SET case_id = $2 WHERE id = $1 AND case_id IS NULL`, [links[line].planItemId, caseId]);
      if ((rowCount ?? 0) > 0) {
        await audit(client, {
          action: "plan.item_case", entity: "patient", entityId: input.patientId, entityLabel: item.description,
          details: { البند: links[line].planItemId, الحالة: caseId, المصدر: `فاتورة ${created.invoice_number}` },
          actor: input.createdBy, actorRole: input.actorRole,
        });
      }
    }

    for (const [line, item] of input.items.entries()) {
      const quantity = Math.max(1, Math.round(item.quantity));
      const unit = Math.max(0, Math.round(item.unitPriceMinor));
      const source = links[line].planItemId;
      await client.query(
        `INSERT INTO invoice_items (invoice_id, service_id, doctor_id, description, quantity, unit_price_minor, total_minor,
                                    source_type, source_id)
         VALUES ($1, $2::int, $3::int, $4, $5, $6, $7, $8::text, $9::bigint)`,
        [invoiceId, item.serviceId, item.doctorId, item.description, quantity, unit, quantity * unit,
          source === null ? null : "plan_item", source]);
    }

    const clinical = links.filter((link) => link.kind === "clinical");
    await audit(client, {
      action: "invoice.create", entity: "invoice", entityId: invoiceId, entityLabel: created.invoice_number,
      details: {
        المريض: input.patientId, الإجمالي: total, الخصم: discount, عدد_البنود: input.items.length,
        ...input.auditDetails,
        ...(clinical.length ? {
          الربط_بالعلاج: clinical.map((link) =>
            `${LINKAGE_SPECIALTY_LABEL[link.specialty!]}: بند ${link.planItemId}${link.planItemCreated ? " (جديد)" : " (قائم)"}`
            + (link.caseId ? ` · حالة ${link.caseId}${link.caseCreated ? " (أولية)" : ""}` : "")).join(" | "),
        } : {}),
      },
      actor: input.createdBy, actorRole: input.actorRole,
    });
    await client.query("COMMIT");
    return { ok: true, invoiceId, replayed: false, planId, links };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Refusal) return { ok: false, reason: error.reason, line: error.line };
    // مفتاحٌ واحد لطلبين متزامنين لمريضين مختلفين: الفهرس الفريد يحسم — تعارضٌ لا فاتورة ثانية.
    if ((error as { code?: string; constraint?: string }).code === "23505"
      && (error as { constraint?: string }).constraint === "invoices_idempotency_key_uniq") {
      return { ok: false, reason: "idempotency_conflict", line: null };
    }
    throw error;
  } finally {
    client.release();
  }
}
