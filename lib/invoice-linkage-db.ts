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
import { normalizeSurfaces } from "./dental";
import type { Currency } from "./money";
import { clinicDateString } from "./schedule";
import type { SpecialtyTemplate } from "./specialty-templates";
import {
  LINKAGE_SPECIALTY_LABEL, caseSiteFits, lineLinkage, scopeNote, sessionsFor, shellCaseTitleFor, siteGroupKey, siteText,
  validateLineSite, type InvoiceLinkageRefusal, type LineSite, type LinkageSpecialty,
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
  /** (INV-LINK TOOTH) أسطح الحشوة كما اختيرت من المخطط (تُطبَّع). */
  surfaces?: string | null;
  /** (INV-LINK TOOTH) أسنان حلقة التاج/القشرة/الجسر كلها — سطرٌ لكل سن، وحالةٌ واحدة للحلقة. */
  episodeTeeth?: number[] | null;
  /** (INV-LINK TOOTH) نطاقٌ بلا سن: علوي/سفلي/الفكّان/كامل الفم. */
  scope?: string | null;
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

/** بند خطةٍ مفتوح يصلح أن تقبله الفاتورة ماليًّا: خطةٌ نشطة موافَق عليها بعملة الفاتورة بلا أقساط، والبند لم يبدأ ولم يُفوتر. */
const OPEN_ITEM_SQL = `SELECT i.id, i.quantity, i.unit_price_minor, i.case_id, i.session_count, i.surfaces
       FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
      WHERE t.patient_id = $1 AND t.status = 'active' AND t.consent_at IS NOT NULL AND t.base_currency = $2
        AND NOT EXISTS (SELECT 1 FROM plan_installments pi WHERE pi.plan_id = t.id)
        AND i.service_id = $3 AND i.tooth_code IS NOT DISTINCT FROM $4::smallint
        AND i.status = 'planned' AND i.billing_status = 'unbilled' AND i.started_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM treatment_sessions s WHERE s.plan_item_id = i.id AND s.status = 'done')
        AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.source_type = 'plan_item' AND ii.source_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM invoice_items ij WHERE ij.plan_item_id = i.id)`;

async function audit(client: DbClient, entry: AuditInput) { await insertAuditRow(client, entry); }

/** روابط فاتورةٍ قائمة كما كُتبت — لإعادة الطلب نفسه بلا أثرٍ ثانٍ (والخطة هي التي أنشأتها الفاتورة وحدها). */
async function existingLinks(client: Pick<DbClient, "query">, invoiceId: number): Promise<{ planId: number | null; links: LineLink[] }> {
  const { rows } = await client.query<{
    plan_item_id: number | null; case_id: number | null; service_id: number | null; category: string | null;
  }>(
    `SELECT ii.plan_item_id, i.case_id, i.service_id, i.category
       FROM invoice_items ii
       LEFT JOIN plan_items i ON i.id = ii.plan_item_id
      WHERE ii.invoice_id = $1 ORDER BY ii.id`, [invoiceId]);
  const { rows: [created] } = await client.query<{ plan_id: number }>(
    `SELECT plan_id FROM plan_items WHERE origin_invoice_id = $1 ORDER BY id LIMIT 1`, [invoiceId]);
  const links = rows.map((row, line) => {
    const linkage = lineLinkage({ serviceId: row.service_id, category: row.category });
    return {
      line, kind: row.plan_item_id === null ? "financial" as const : "clinical" as const,
      specialty: row.plan_item_id !== null && linkage.kind === "clinical" ? linkage.specialty : null,
      planItemId: row.plan_item_id, planItemCreated: false,
      caseId: row.case_id, caseCreated: false,
    };
  });
  return { planId: created?.plan_id ?? null, links };
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
    /* (INV-LINK TOOTH) موضع كل بندٍ علاجي يُتحقق قبل أي كتابة: خدمةٌ تخص سنًّا بلا سن لا تُحفظ مرتبطةً (fail closed). */
    const sites: (LineSite | null)[] = input.items.map((item, line) => {
      if (linkages[line].kind !== "clinical") return null;
      const checked = validateLineSite(item);
      if (!checked.ok) throw new Refusal(checked.reason, line);
      return checked.site;
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
          LIMIT 1`, [input.patientId, item.serviceId, sites[line]!.toothCode]);
      if (billed) throw new Refusal("already_billed", line);
      /* بند الخطة يُقفل أولًا ثم تُعاد قراءة أهليته في جملةٍ جديدة بعد انتظار القفل — بالترتيب نفسه الذي يقفل به
         التوقيعُ البنود (loadPlanItemsForPricing): زيارةٌ وقّعت جلسته أثناء الانتظار تُرى، فلا يفوتره البابان معًا. */
      const params = [input.patientId, input.baseCurrency, item.serviceId, sites[line]!.toothCode];
      const { rows: candidates } = await client.query<{ id: number }>(
        `${OPEN_ITEM_SQL} AND i.id <> ALL($5::int[]) ORDER BY i.id`, [...params, claimed]);
      const candidateIds = candidates.map((row) => row.id);
      if (candidateIds.length > 0) {
        await client.query(`SELECT id FROM plan_items WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [candidateIds]);
      }
      const { rows: open } = candidateIds.length === 0 ? { rows: [] } : await client.query<{
        id: number; quantity: number; unit_price_minor: string; case_id: number | null;
        session_count: number; surfaces: string | null;
      }>(`${OPEN_ITEM_SQL} AND i.id = ANY($5::int[]) ORDER BY i.id`, [...params, candidateIds]);
      if (open.length === 0) { fresh.push(line); continue; }
      /* المطابقة على شكل العمل كله لا المبلغ وحده: الكمية، والمبلغ، وبلا أسطح (الفاتورة لا تحملها)، وعدد الجلسات إن طُلب. */
      const quantity = Math.max(1, Math.round(item.quantity));
      const totalMinor = quantity * Math.round(item.unitPriceMinor);
      const sameTotal = open.filter((row) => row.quantity * Number(row.unit_price_minor) === totalMinor);
      if (sameTotal.length === 0) throw new Refusal("amount_mismatch", line);
      const surfaces = sites[line]?.surfaces ?? null;
      const exact = sameTotal.filter((row) => row.quantity === quantity && normalizeSurfaces(row.surfaces) === surfaces
        && (item.sessions === null || row.session_count === item.sessions));
      if (exact.length === 0) throw new Refusal("shape_mismatch", line);
      if (exact.length > 1) throw new Refusal("ambiguous_item", line);
      const match = exact[0];
      /* حالةٌ اختارها المستخدم تخالف حالة البند المطابق: رفضٌ صريح — لا يُنقل البند بين الحالات من الفاتورة. */
      if (item.caseId !== null && match.case_id !== null && match.case_id !== item.caseId) {
        throw new Refusal("case_mismatch", line);
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
            toothCode: sites[line]!.toothCode, surfaces: sites[line]!.surfaces,
            quantity: Math.max(1, Math.round(item.quantity)), unitPriceMinor: Math.round(item.unitPriceMinor),
            billingRule: "on_completion" as const,
            sessionCount: sessionsFor(item.category, item.sessions, input.templates), note: scopeNote(sites[line]!),
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
    const caseBySpecialty = new Map<string, { id: number; created: boolean }>();
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
        const site = sites[line]!;
        const groupKey = siteGroupKey(specialty, site);
        const known = caseBySpecialty.get(groupKey);
        if (known) {
          caseId = known.id;
        } else {
          /* حالةٌ مفتوحة للتخصص تُعاد فقط إن وافق موضعُها سنَّ البند (للتخصص الموضعي): علاج عصب 36 لا يُلحق بحالة 11. */
          const { rows: sameSpecialty } = await client.query<{ id: number; site: string | null }>(
            `SELECT id, site FROM clinical_cases WHERE patient_id = $1 AND specialty = $2 AND ${OPEN_CASE} ORDER BY id FOR UPDATE`,
            [input.patientId, specialty]);
          const open = sameSpecialty.filter((row) => caseSiteFits(specialty, row.site, site));
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
            const title = orthoCaseId !== null ? "تقويم الأسنان" : shellCaseTitleFor(specialty, site);
            const { rows: [shell] } = await client.query<{ id: number }>(
              `INSERT INTO clinical_cases (patient_id, specialty, title, site, ortho_case_id, created_by, origin, origin_invoice_id)
               VALUES ($1, $2, $3, $4::text, $5::int, $6, 'invoice', $7) RETURNING id`,
              [input.patientId, specialty, title, siteText(site), orthoCaseId,
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
          caseBySpecialty.set(groupKey, { id: caseId, created: caseCreated });
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
                                    source_type, source_id, plan_item_id)
         VALUES ($1, $2::int, $3::int, $4, $5, $6, $7, $8::text, $9::bigint, $10::int)`,
        [invoiceId, item.serviceId, item.doctorId, item.description, quantity, unit, quantity * unit,
          source === null ? null : "plan_item", source, source]);
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

// ─── المعاينة (قراءة فقط) ─────────────────────────────────────────────────────

export interface LinePreview {
  line: number;
  kind: "financial" | "clinical";
  specialty: LinkageSpecialty | null;
  specialtyLabel: string | null;
  /** بند الخطة: قائمٌ مطابق يُعاد، أو جديد. */
  item: { mode: "existing" | "new"; id: number | null } | null;
  /** الحالة: قائمة تُربط، أو أولية تُنشأ، أو جسرٌ لحالة تقويم قائمة، أو يلزم الاختيار، أو لا حاجة. */
  case: { mode: "existing" | "new" | "bridge" | "choose" | "none"; id: number | null; title: string | null;
    options: { id: number; title: string }[] } | null;
  /** سبب رفضٍ متوقَّع (المعاينة تحذّر؛ الحفظ يرفض فعلًا). */
  refusal: InvoiceLinkageRefusal | null;
}

/**
 * ماذا ستفعل الفاتورة بالعلاج — قبل الحفظ. قراءةٌ بلا أقفال ولا كتابة، بالقواعد نفسها التي يطبّقها
 * `createLinkedInvoice` (والحفظ يعيد الفحص تحت القفل؛ المعاينة ليست وعدًا).
 */
export async function previewInvoiceLinkage(input: {
  patientId: number; baseCurrency: Currency;
  items: { serviceId: number | null; category: string | null; quantity: number; unitPriceMinor: number;
    toothCode: number | null; caseId: number | null; sessions?: number | null;
    surfaces?: string | null; episodeTeeth?: number[] | null; scope?: string | null }[];
}): Promise<LinePreview[]> {
  await ensureSchema();
  const pool = getPool();
  const claimed: number[] = [];
  const newCaseForGroup = new Set<string>();
  const previews: LinePreview[] = [];
  for (const [line, item] of input.items.entries()) {
    const linkage = lineLinkage({ serviceId: item.serviceId, category: item.category });
    if (linkage.kind !== "clinical") {
      previews.push({ line, kind: "financial", specialty: null, specialtyLabel: null, item: null, case: null, refusal: null });
      continue;
    }
    const preview: LinePreview = {
      line, kind: "clinical", specialty: linkage.specialty, specialtyLabel: LINKAGE_SPECIALTY_LABEL[linkage.specialty],
      item: { mode: "new", id: null }, case: linkage.needsCase ? null : { mode: "none", id: null, title: null, options: [] },
      refusal: null,
    };
    const checked = validateLineSite(item);
    if (!checked.ok) { preview.refusal = checked.reason; previews.push(preview); continue; }
    const site = checked.site;
    const { rows: [billed] } = await pool.query(
      `SELECT 1 FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id JOIN invoices v ON v.id = i.billed_invoice_id
        WHERE t.patient_id = $1 AND i.service_id = $2 AND i.tooth_code IS NOT DISTINCT FROM $3::smallint
          AND i.billing_status = 'billed' AND v.status <> 'cancelled' AND i.status = 'planned' AND i.started_at IS NULL
        LIMIT 1`, [input.patientId, item.serviceId, site.toothCode]);
    if (billed) { preview.refusal = "already_billed"; previews.push(preview); continue; }
    const { rows: open } = await pool.query<{
      id: number; quantity: number; unit_price_minor: string; case_id: number | null; session_count: number; surfaces: string | null;
    }>(`${OPEN_ITEM_SQL} AND i.id <> ALL($5::int[]) ORDER BY i.id`,
      [input.patientId, input.baseCurrency, item.serviceId, site.toothCode, claimed]);
    let linkedCase: number | null = null;
    if (open.length > 0) {
      // نفس قاعدة الحفظ: المبلغ، ثم شكل العمل (الكمية/الأسطح/الجلسات)، ثم التفرّد.
      const quantity = Math.max(1, Math.round(item.quantity));
      const totalMinor = quantity * Math.round(item.unitPriceMinor);
      const sessions = item.sessions ?? null;
      const sameTotal = open.filter((row) => row.quantity * Number(row.unit_price_minor) === totalMinor);
      const exact = sameTotal.filter((row) => row.quantity === quantity && normalizeSurfaces(row.surfaces) === site.surfaces
        && (sessions === null || row.session_count === sessions));
      if (sameTotal.length === 0) preview.refusal = "amount_mismatch";
      else if (exact.length === 0) preview.refusal = "shape_mismatch";
      else if (exact.length > 1) preview.refusal = "ambiguous_item";
      const match = exact.length === 1 ? exact[0] : null;
      if (match) {
        claimed.push(match.id);
        preview.item = { mode: "existing", id: match.id };
        linkedCase = match.case_id;
        if (item.caseId !== null && match.case_id !== null && match.case_id !== item.caseId) preview.refusal = "case_mismatch";
      } else {
        preview.item = { mode: "existing", id: null };
      }
    }
    if (linkage.needsCase) {
      const { rows: sameSpecialty } = await pool.query<{ id: number; title: string; site: string | null }>(
        `SELECT id, title, site FROM clinical_cases WHERE patient_id = $1 AND specialty = $2 AND ${OPEN_CASE} ORDER BY id`,
        [input.patientId, linkage.specialty]);
      // الحالة المختارة صراحةً تُقبل من أي حالة مفتوحة للتخصص (كالحفظ)؛ والتلقائية من الحالات الموافقة للسن فقط.
      const all = sameSpecialty.map(({ id, title }) => ({ id, title }));
      const open = sameSpecialty.filter((row) => caseSiteFits(linkage.specialty, row.site, site))
        .map(({ id, title }) => ({ id, title }));
      const groupKey = siteGroupKey(linkage.specialty, site);
      if (item.caseId !== null) {
        const chosen = all.find((one) => one.id === item.caseId);
        preview.case = chosen ? { mode: "existing", id: chosen.id, title: chosen.title, options: open.length > 1 ? open : all }
          : { mode: "choose", id: null, title: null, options: open.length > 0 ? open : all };
        if (!chosen) preview.refusal = preview.refusal ?? "bad_case";
      } else if (linkedCase !== null) {
        const found = all.find((one) => one.id === linkedCase);
        preview.case = { mode: "existing", id: linkedCase, title: found?.title ?? null, options: [] };
      } else if (newCaseForGroup.has(groupKey)) {
        preview.case = { mode: "new", id: null, title: shellCaseTitleFor(linkage.specialty, site), options: [] };
      } else if (open.length > 1) {
        preview.case = { mode: "choose", id: null, title: null, options: open };
        preview.refusal = preview.refusal ?? "ambiguous_case";
      } else if (open.length === 1) {
        preview.case = { mode: "existing", id: open[0].id, title: open[0].title, options: [] };
      } else {
        let bridge = false;
        if (linkage.specialty === "orthodontics") {
          const { rows: [ortho] } = await pool.query(
            `SELECT 1 FROM ortho_cases o WHERE o.patient_id = $1 AND o.status IN ('active', 'retention')
                AND NOT EXISTS (SELECT 1 FROM clinical_cases c WHERE c.ortho_case_id = o.id) LIMIT 1`, [input.patientId]);
          bridge = Boolean(ortho);
        }
        newCaseForGroup.add(groupKey);
        preview.case = bridge
          ? { mode: "bridge", id: null, title: "تقويم الأسنان", options: [] }
          : { mode: "new", id: null, title: shellCaseTitleFor(linkage.specialty, site), options: [] };
      }
    }
    previews.push(preview);
  }
  return previews;
}
