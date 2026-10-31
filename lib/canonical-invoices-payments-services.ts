import "server-only";
import { NextResponse } from "next/server";
import {
  collectCanonicalApprovedAgreementInTransaction,
  hydrateCollectedAgreementPayments,
} from "./approved-agreements";
import { auditChanges, auditSnapshot, SERVICE_AUDIT_FIELDS } from "./audit-diff";
import { canonicalPatientReadFailure, NO_STORE } from "./canonical-patient-http";
import {
  runCanonicalReadSnapshot,
  type CanonicalSnapshotQuery,
  type CanonicalSnapshotScope,
} from "./canonical-read-snapshot";
import { CLINIC_ZONE_FALLBACK } from "./clinicZone";
import {
  CollectionAttemptError,
  isRetiredCollectionKey,
  retireCanonicalCollectionAttemptInTx,
  retiredCollectionRefusal,
} from "./collection-attempts";
import {
  AUTO_MATERIAL_REASON_PREFIX,
  CLINIC_TIME_ZONE,
  correctPaymentInTx,
  createInventoryItemInTx,
  createInventoryMovementInTransaction,
  createServiceInTx,
  fillProvisionalServicePricesInTx,
  getInvoice,
  getPatientWith,
  getPaymentByIdempotencyKeyWith,
  getPaymentWith,
  getPlanWith,
  getPool,
  getServiceWith,
  getSettingsInTransaction,
  insertAuditRow,
  inventoryAlertsWith,
  invoiceLinkedPaymentsByCurrencyWith,
  isPeriodLockedWith,
  isPlanFundedByAgreementWith,
  issuedCostForPatientWith,
  listInventoryItemsWith,
  listPartiesWith,
  listPatientInvoices,
  listPaymentsByDateWith,
  listServicesWith,
  patientInDoctorScopeWith,
  priceServiceBatchInTx,
  recordPaymentInTx,
  recordPlanInstallmentInTransaction,
  recordReversedInstallmentRecoveryInTx,
  recordSettingsOwnedPaymentInTx,
  setInvoiceStatusInTx,
  updateInventoryItemInTx,
  updateServiceInTx,
  visitPatientOfWith,
  type CorrectPaymentRefusal,
  type CorrectionTarget,
  type DbClient,
} from "./db";
import { DebtRepaymentError, invoiceDebtRepaymentReceipt } from "./debt-installments-db";
import { bodyErrorResponse, readJsonBody } from "./http-body";
import { IDEMPOTENCY_KEY_PATTERN } from "./idempotency-key";
import { isMovementKind, itemCategoryLabel } from "./inventory";
import { inventoryMovementForRead } from "./inventory-domain/presentation";
import { inventoryDetailWithLinks, readInventoryValuation } from "./inventory-domain/read";
import { createCanonicalInventoryPurchaseInTx } from "./inventory-purchase-db";
import {
  canonicalPurchaseRequest,
  INVENTORY_PURCHASE_KEY_HEADER,
  isPurchaseKey,
  isPurchaseRecord,
  isUnwrappedFinancialPurchase,
  normalizePurchaseReason,
  purchaseEnvelope,
} from "./inventory-purchase-protocol";
import {
  addCanonicalInvoiceServiceInTx,
  InvoiceAddServiceError,
  previewCanonicalInvoiceAddServiceWith,
  readCanonicalInvoiceAddServiceWith,
} from "./invoice-add-service-db";
import { InvoiceArchiveError } from "./invoice-archive";
import {
  changeCanonicalInvoiceArchiveInTx,
  listCanonicalInvoiceArchiveWith,
  readCanonicalInvoiceArchiveWith,
} from "./invoice-archive-db";
import {
  INVOICE_IDEMPOTENCY_PATTERN,
  INVOICE_LINKAGE_MESSAGE,
  linkageRefusalStatus,
} from "./invoice-clinical-linkage";
import {
  createLinkedInvoiceInTransaction,
  InvoiceLinkageError,
  invoicePlanChoices,
  previewInvoiceLinkage,
  recoverLinkedInvoiceInTransaction,
} from "./invoice-linkage-db";
import { InvoiceVisitContextError } from "./invoice-visit-context";
import { invoicePriceQuote } from "./invoice-price-quote";
import { checkInvoiceAuthority, formatPriceOverrides } from "./invoice-pricing";
import {
  readCanonicalInvoiceRevisionWith,
  reviseCanonicalInvoiceInTx,
} from "./invoice-revision-db";
import {
  hasInvoiceCatalogQuote,
  hasInvoiceLabWork,
  invoiceCatalogRequestFingerprint,
  invoiceCommandFingerprint,
  invoiceTemplateRequestFingerprint,
  parseInvoiceCommand,
} from "./invoice-template";
import {
  InvoiceTemplateAuthorityError,
  InvoiceTemplateAuthorizationError,
  InvoiceTemplateBusyError,
  type CanonicalInvoiceTemplateAuthority,
} from "./invoice-template-db";
import {
  labWorkIntentSupported,
  LabWorkIntentError,
  readLabWorkForPlanItems,
} from "./lab-work-intent-db";
import {
  CLINIC_BASE_CURRENCY,
  FinancialCurrencyIntegrityError,
  formatMoney,
  isCurrency,
  parseAmount,
  type Currency,
} from "./money";
import { provisionalFills } from "./provisionalPrices";
import { parseRecoveryIntent } from "./reversed-installment-recovery";
import { clinicDateString } from "./schedule";
import { JSON_BODY_LIMIT_BYTES } from "./security-limits";
import { readForeignPrices } from "./service-foreign-prices";
import { catalogPricesByCurrency, foreignRatesFromSettings } from "./service-pricing";
import { readPriceBatch } from "./servicePricing";
import { rateFromSettings } from "./settings";
import {
  parseSimilarCollectionReviewHeader,
  SIMILAR_COLLECTION_REVIEW_HEADER,
  similarCollectionRefusal,
  SimilarCollectionReviewRequired,
} from "./similar-collection";
import { effectiveTemplates } from "./specialty-templates";
import { staffAdmissionRefusal } from "./staff-capability-editor";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  assertStaffOperation,
  staffOperationCapabilities,
  staffOperationIdentity,
  staffOperationPatientScope,
  withStaffOperation,
} from "./staff-operation-runtime";

/**
 * Canonical Invoices, Payments, Services, Service-Materials & Legacy Inventory
 * Foundation Routes (M2 Slice 37a — 32 HTTP methods across 20 route files).
 */

const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

class CanonicalSlice37aRefusal extends Error {
  readonly code: string;
  readonly explicitCode: boolean;
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 500 | 503,
    message: string,
    code?: string,
  ) {
    super(message);
    this.name = "CanonicalSlice37aRefusal";
    this.explicitCode = typeof code === "string" && code.length > 0;
    this.code =
      code && /^[a-z][a-z_]*$/.test(code)
        ? code
        : status === 404
          ? "not_found"
          : status === 403
            ? "forbidden"
            : status === 409
              ? "conflict"
              : "invalid_request";
  }
}

function parsePositiveId(raw: string): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
}

function handleSlice37aError(error: unknown, fallbackMessage: string): NextResponse {
  const bounded = bodyErrorResponse(error);
  if (bounded) return bounded;
  if (error instanceof CanonicalSlice37aRefusal) {
    return NextResponse.json(
      error.explicitCode ? { code: error.code, message: error.message } : { message: error.message },
      { status: error.status, headers: NO_STORE },
    );
  }
  const refusal = staffAdmissionRefusal(error);
  if (refusal) {
    return NextResponse.json(
      { code: refusal.code, message: refusal.message },
      { status: refusal.status, headers: NO_STORE },
    );
  }
  return canonicalPatientReadFailure(error, fallbackMessage);
}

async function patientVisibleInSnapshot(
  query: CanonicalSnapshotQuery,
  scope: CanonicalSnapshotScope,
  patientId: number,
): Promise<boolean> {
  if (scope.patientScope.kind === "none") return false;
  const patient = await getPatientWith(query, patientId);
  if (!patient) return false;
  if (scope.patientScope.kind === "all") return true;
  return patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, patientId);
}

/* ============================================================================
 * 1. INVOICES (/api/invoices/**)
 * ============================================================================ */

export async function invoicesListCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  }
  try {
    const invoices = await runCanonicalReadSnapshot(
      session,
      "finance.invoices.view",
      async (query, scope) => {
        if (
          scope.patientScope.kind === "own" &&
          !(await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, patientId))
        ) {
          throw new CanonicalSlice37aRefusal(403, "غير مصرّح لك بالوصول لهذا الملف.");
        }
        return listPatientInvoices(patientId, query as DbClient);
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(invoices, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37aError(error, "تعذّر تحميل الفواتير.");
  }
}

export async function invoicesCreateCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const templateIntent =
    source !== null &&
    typeof source === "object" &&
    !Array.isArray(source) &&
    source.templateSelection !== null &&
    typeof source.templateSelection === "object" &&
    !Array.isArray(source.templateSelection);
  const catalogIntent =
    source !== null &&
    typeof source === "object" &&
    !Array.isArray(source) &&
    hasInvoiceCatalogQuote(source);

  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "finance.invoices.create",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.invoices.create");
        const caps = await staffOperationCapabilities(
          client,
          handle,
          "finance.invoices.create",
          [
            "clinical.lab.order",
            "clinical.visits.document",
            "finance.price-increases.apply",
            "finance.discounts.apply",
            "finance.discounts.override",
          ] as const,
        );
        if (hasInvoiceLabWork(source) && !caps.has("clinical.lab.order")) {
          throw new CanonicalSlice37aRefusal(403, "وصفة المختبر السريرية للطبيب والإدارة فقط.");
        }
        const verifyLiveSession = async (c: DbClient) => {
          await assertStaffOperation(c, handle, "finance.invoices.create");
        };
        const priceCapabilities = {
          canIncreasePrice: caps.has("finance.price-increases.apply"),
          canApplyDiscount: caps.has("finance.discounts.apply"),
          canOverrideDiscount: caps.has("finance.discounts.override"),
        };
        const actor = {
          userId: identity.userId,
          username: identity.username,
          role: identity.role,
        };

        if (
          (templateIntent || catalogIntent) &&
          typeof source.idempotencyKey === "string" &&
          INVOICE_IDEMPOTENCY_PATTERN.test(source.idempotencyKey.trim()) &&
          Number.isInteger(Number(source.patientId)) &&
          Number(source.patientId) > 0
        ) {
          const recovered = await recoverLinkedInvoiceInTransaction(client, {
            patientId: Number(source.patientId),
            idempotencyKey: source.idempotencyKey.trim(),
            requestHash: templateIntent
              ? invoiceTemplateRequestFingerprint(source, actor)
              : invoiceCatalogRequestFingerprint(source, actor),
            createdBy: identity.username,
            actorRole: identity.role,
            actorUserId: identity.userId,
            verifyLiveSession,
            ...(typeof source.visitId === "number" ? { visitId: source.visitId } : {}),
          });
          if (recovered && !recovered.ok) {
            return {
              status: recovered.reason === "no_patient" ? 404 : linkageRefusalStatus(recovered.reason),
              body: {
                code: recovered.reason,
                message:
                  recovered.reason === "no_patient"
                    ? "المريض غير موجود."
                    : INVOICE_LINKAGE_MESSAGE[recovered.reason],
              },
            };
          }
          if (recovered?.ok && recovered.invoice) {
            const repayment = Object.hasOwn(source, "repaymentTerms")
              ? await invoiceDebtRepaymentReceipt(recovered.invoice.patientId, recovered.invoice.id, client)
              : undefined;
            return {
              status: 200,
              body: {
                ...recovered.invoice,
                clinical: { planId: recovered.planId, links: recovered.links },
                ...(recovered.labWork ? { labWork: recovered.labWork } : {}),
                ...(typeof source.visitId === "number" ? { visitId: recovered.visitId } : {}),
                ...(Object.hasOwn(source, "repaymentTerms") ? { repayment } : {}),
                replayed: true,
              },
            };
          }
        }

        const services = new Map((await listServicesWith(client, true)).map((s) => [s.id, s]));
        const doctors = new Set((await listPartiesWith(client, "doctor")).map((p) => p.id));
        const settings = await getSettingsInTransaction(client, { requireStoredExchangeRates: true });
        const parsed = parseInvoiceCommand(source, services, doctors, settings, true);
        if (!parsed.ok) {
          return {
            status: parsed.status ?? 400,
            body: { message: parsed.message, ...(parsed.code ? { code: parsed.code } : {}) },
          };
        }

        const pScope = await staffOperationPatientScope(client, handle, "finance.invoices.create");
        if (
          pScope.kind === "own" &&
          !(await patientInDoctorScopeWith(client, pScope.clinicianPartyId, parsed.patientId))
        ) {
          throw new CanonicalSlice37aRefusal(403, "غير مصرّح لك بالوصول لهذا الملف.");
        }

        const authority = checkInvoiceAuthority({
          requireInvoiceManualReason: true,
          lines: parsed.authorityLines,
          currency: parsed.baseCurrency,
          rates: foreignRatesFromSettings(settings),
          role: identity.role,
          capabilities: priceCapabilities,
          maxDiscountPercent: Number(settings["billing.max_discount_percent"]),
          totalMinor: parsed.items.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0),
          discountMinor: parsed.discountMinor,
          discountReason: typeof source.discountReason === "string" ? source.discountReason : null,
        });
        if (!authority.ok) {
          return {
            status: authority.forbidden ? 403 : 400,
            body: { message: authority.message },
          };
        }

        const canonicalAuthority: CanonicalInvoiceTemplateAuthority = {
          userId: identity.userId,
          username: identity.username,
          role: identity.role,
          canDocumentLabWork: caps.has("clinical.lab.order"),
          priceCapabilities,
          verifyLiveSession,
        };

        await client.query("SAVEPOINT canonical_create_linked_invoice");
        try {
          const result = await createLinkedInvoiceInTransaction(client, {
            patientId: parsed.patientId,
            ...(parsed.visitId !== undefined ? { visitId: parsed.visitId } : {}),
            baseCurrency: parsed.baseCurrency,
            existingPlanId: parsed.existingPlanId,
            discountMinor: parsed.discountMinor,
            note: parsed.note,
            createdBy: identity.username,
            actorRole: identity.role,
            items: parsed.items,
            ...(parsed.labRetirements !== undefined ? { labRetirements: parsed.labRetirements } : {}),
            templates: effectiveTemplates(settings["plans.specialty_templates"]).templates,
            idempotencyKey: parsed.idempotencyKey,
            ...(parsed.template
              ? {
                  templateAuthority: {
                    source,
                    fingerprint: invoiceCommandFingerprint(parsed),
                    canonical: canonicalAuthority,
                  },
                }
              : {
                  catalogueAuthority: {
                    source,
                    fingerprint: invoiceCommandFingerprint(parsed),
                    canonical: canonicalAuthority,
                  },
                }),
            ...(hasInvoiceLabWork(source)
              ? { canonicalOperation: { handle, action: "finance.invoices.create" } }
              : {}),
            requestHash: parsed.idempotencyKey
              ? parsed.template
                ? invoiceTemplateRequestFingerprint(source, actor)
                : catalogIntent
                  ? invoiceCatalogRequestFingerprint(source, actor)
                  : invoiceCommandFingerprint(parsed)
              : null,
            auditDetails: {
              ...(parsed.template
                ? { قالب_العلاج: parsed.template.templateId, نسخة_القالب: parsed.template.version }
                : {}),
              ...(authority.discount
                ? { سبب_الخصم: authority.discount.reason, نسبة_الخصم: authority.discount.percent }
                : {}),
              ...(authority.overrides.length
                ? { أسعار_معدلة: formatPriceOverrides(authority.overrides) }
                : {}),
            },
          });

          const invoice = result.invoice ?? (await getInvoice(result.invoiceId, client))!;
          const repayment = Object.hasOwn(source, "repaymentTerms")
            ? await invoiceDebtRepaymentReceipt(parsed.patientId, invoice.id, client)
            : undefined;
          if (result.replayed) {
            await client.query("ROLLBACK TO SAVEPOINT canonical_create_linked_invoice");
            await client.query("RELEASE SAVEPOINT canonical_create_linked_invoice");
          } else {
            await client.query("RELEASE SAVEPOINT canonical_create_linked_invoice");
          }
          return {
            status: result.replayed ? 200 : 201,
            body: {
              ...invoice,
              clinical: { planId: result.planId, links: result.links },
              ...(result.labWork ? { labWork: result.labWork } : {}),
              ...(result.visitId !== undefined ? { visitId: result.visitId } : {}),
              ...(Object.hasOwn(source, "repaymentTerms") ? { repayment } : {}),
              replayed: result.replayed,
            },
          };
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT canonical_create_linked_invoice").catch(() => undefined);
          await client.query("RELEASE SAVEPOINT canonical_create_linked_invoice").catch(() => undefined);
          if (error instanceof InvoiceVisitContextError) {
            return {
              status: linkageRefusalStatus("visit_context_invalid"),
              body: { message: INVOICE_LINKAGE_MESSAGE.visit_context_invalid },
            };
          }
          if (error instanceof InvoiceLinkageError) {
            if (error.reason === "no_patient") {
              return { status: 404, body: { message: "المريض غير موجود." } };
            }
            const prefix = error.line !== null ? `البند ${error.line + 1}: ` : "";
            return {
              status: linkageRefusalStatus(error.reason),
              body: { message: prefix + INVOICE_LINKAGE_MESSAGE[error.reason] },
            };
          }
          throw error;
        }
      },
    );
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error) {
    if (error instanceof LabWorkIntentError) {
      return NextResponse.json({ code: error.code, message: error.message }, { status: error.status });
    }
    if (error instanceof DebtRepaymentError) {
      return NextResponse.json(
        { code: error.code, message: error.message },
        { status: error.code === "unauthorized" ? 401 : error.code === "invalid" ? 400 : 409 },
      );
    }
    if (error instanceof InvoiceTemplateAuthorizationError) {
      return NextResponse.json({ code: error.code, message: error.message }, { status: 401 });
    }
    if (error instanceof InvoiceTemplateAuthorityError || error instanceof InvoiceTemplateBusyError) {
      return NextResponse.json({ code: error.code, message: error.message }, { status: 409 });
    }
    return handleSlice37aError(error, "تعذّر إنشاء الفاتورة. أعد المحاولة.");
  }
}

export async function invoiceGetCanonicalResponse(
  idRaw: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const id = parsePositiveId(idRaw);
  if (!id) return NextResponse.json({ message: "رقم الفاتورة غير صالح." }, { status: 400 });
  try {
    const invoice = await runCanonicalReadSnapshot(
      session,
      "finance.invoices.view",
      async (query, scope) => {
        const found = await getInvoice(id, query as DbClient);
        if (!found) throw new CanonicalSlice37aRefusal(404, "الفاتورة غير موجودة.");
        if (
          scope.patientScope.kind === "own" &&
          !(await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, found.patientId))
        ) {
          throw new CanonicalSlice37aRefusal(403, "غير مصرّح لك بالوصول لهذا الملف.");
        }
        return found;
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(invoice, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37aError(error, "تعذّر تحميل الفاتورة.");
  }
}

export async function invoicePatchCanonicalResponse(
  request: Request,
  idRaw: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const id = parsePositiveId(idRaw);
  if (!id) return NextResponse.json({ message: "رقم الفاتورة غير صالح." }, { status: 400 });
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const status = (body as Record<string, unknown>)?.status;
  if (status !== "open" && status !== "paid" && status !== "cancelled") {
    return NextResponse.json({ message: "حالة غير معروفة." }, { status: 400 });
  }
  const rawReason = (body as Record<string, unknown>)?.reason;
  const reason = typeof rawReason === "string" ? rawReason.trim().slice(0, 300) : "";
  if (status === "cancelled" && reason.length < 3) {
    return NextResponse.json({ message: "اكتب سبب إلغاء الفاتورة." }, { status: 400 });
  }

  const action =
    status === "cancelled"
      ? "finance.invoices.cancel"
      : status === "paid"
        ? "finance.invoices.mark-paid"
        : "finance.invoices.create";

  try {
    const outcome = await withStaffOperation(getPool(), session, action, async (client, handle) => {
      const identity = await staffOperationIdentity(client, handle, action);
      const existing = await getInvoice(id, client);
      if (existing) {
        const pScope = await staffOperationPatientScope(client, handle, action);
        if (
          pScope.kind === "own" &&
          !(await patientInDoctorScopeWith(client, pScope.clinicianPartyId, existing.patientId))
        ) {
          throw new CanonicalSlice37aRefusal(403, "غير مصرّح لك بالوصول لهذا الملف.");
        }
        if (await isPeriodLockedWith(client, existing.createdAt.slice(0, 10))) {
          return {
            status: 409,
            body: { message: "الفاتورة في فترة مقفلة. صحّحها بفاتورة أو قيد في الفترة المفتوحة." },
          };
        }
      }

      const updated = await setInvoiceStatusInTx(client, id, status, {
        actor: identity.username,
        actorRole: identity.role,
      });
      if (!updated) {
        return {
          status: 409,
          body: { message: "الفاتورة غير موجودة أو ملغاة — والملغاة لا تُعاد." },
        };
      }
      if (status === "cancelled") {
        const linked = await invoiceLinkedPaymentsByCurrencyWith(client, id);
        const paidText = linked.map((row) => formatMoney(row.netMinor, row.currency)).join(" · ");
        await insertAuditRow(client, {
          action: "invoice.cancel",
          entity: "invoice",
          entityId: id,
          entityLabel: updated.invoiceNumber,
          details: {
            الصافي: updated.totalMinor - updated.discountMinor,
            العملة: updated.baseCurrency,
            المريض: updated.patientId,
            السبب: reason,
            مدفوع_عليها: linked.length > 0 ? paidText : null,
          },
          actor: identity.username,
          actorRole: identity.role,
        });
        return {
          status: 200,
          body: {
            ...updated,
            cancellation: {
              reason,
              paidOnInvoice: linked,
              guidance:
                linked.length > 0
                  ? `دُفع على هذه الفاتورة ${paidText}. المبلغ باقٍ رصيدًا دائنًا للمريض: استرده له من الصندوق، أو اتركه يسدّد فاتورته القادمة.`
                  : null,
            },
          },
        };
      }
      return { status: 200, body: updated };
    });
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error) {
    return handleSlice37aError(error, "تعذّر تنفيذ الإجراء.");
  }
}

function invoiceAddServiceFailure(error: unknown): NextResponse {
  const bounded = bodyErrorResponse(error);
  if (bounded) return bounded;
  if (error instanceof InvoiceAddServiceError) {
    return NextResponse.json(
      {
        code: error.code,
        message: error.message,
        ...(error.terminal
          ? { terminal: true, idempotencyKey: error.idempotencyKey, requestHash: error.requestHash }
          : {}),
      },
      {
        status:
          error.code === "unauthorized"
            ? 403
            : error.code === "missing"
              ? 404
              : error.code === "invalid"
                ? 400
                : 409,
        headers: NO_STORE,
      },
    );
  }
  return handleSlice37aError(
    error,
    "تعذّر تأكيد إضافة الخدمة؛ احتفظ بالطلب نفسه وأعد المحاولة للتحقق من النتيجة.",
  );
}

export async function invoiceAddServiceGetCanonicalResponse(
  idRaw: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const id = parsePositiveId(idRaw);
  if (!id) return invoiceAddServiceFailure(new InvoiceAddServiceError("invalid", "رقم الفاتورة غير صالح."));
  try {
    const view = await runCanonicalReadSnapshot(
      session,
      "finance.invoices.create",
      async (query, scope) => {
        const data = await readCanonicalInvoiceAddServiceWith(query, id);
        if (
          scope.patientScope.kind === "own" &&
          !(await patientInDoctorScopeWith(
            query,
            scope.patientScope.clinicianPartyId,
            data.original.patientId,
          ))
        ) {
          throw new InvoiceAddServiceError("unauthorized", "غير مصرّح لك بالوصول لهذا الملف.");
        }
        return data;
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(view, { headers: NO_STORE });
  } catch (error) {
    return invoiceAddServiceFailure(error);
  }
}

export async function invoiceAddServicePreviewCanonicalResponse(
  request: Request,
  idRaw: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const id = parsePositiveId(idRaw);
  if (!id) return invoiceAddServiceFailure(new InvoiceAddServiceError("invalid", "رقم الفاتورة غير صالح."));
  try {
    const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    const preview = await runCanonicalReadSnapshot(
      session,
      "finance.invoices.create",
      async (query, scope) => {
        const result = await previewCanonicalInvoiceAddServiceWith(query, id, body, {
          userId: scope.userId,
          username: scope.username,
          role: scope.role,
          capabilities: {
            canIncreasePrice: scope.granted("finance.price-increases.apply"),
            canApplyDiscount: scope.granted("finance.discounts.apply"),
            canOverrideDiscount: scope.granted("finance.discounts.override"),
          },
        });
        if (
          scope.patientScope.kind === "own" &&
          !(await patientInDoctorScopeWith(
            query,
            scope.patientScope.clinicianPartyId,
            result.original.patientId,
          ))
        ) {
          throw new InvoiceAddServiceError("unauthorized", "غير مصرّح لك بالوصول لهذا الملف.");
        }
        return result;
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(preview, { headers: NO_STORE });
  } catch (error) {
    return invoiceAddServiceFailure(error);
  }
}

export async function invoiceAddServicePostCanonicalResponse(
  request: Request,
  idRaw: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const id = parsePositiveId(idRaw);
  if (!id) return invoiceAddServiceFailure(new InvoiceAddServiceError("invalid", "رقم الفاتورة غير صالح."));
  try {
    const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "finance.invoices.create",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.invoices.create");
        const caps = await staffOperationCapabilities(
          client,
          handle,
          "finance.invoices.create",
          [
            "clinical.lab.order",
            "finance.price-increases.apply",
            "finance.discounts.apply",
            "finance.discounts.override",
          ] as const,
        );
        const ownerRow = (
          await client.query<{ patient_id: number }>("SELECT patient_id FROM invoices WHERE id = $1", [id])
        ).rows[0];
        if (ownerRow) {
          const pScope = await staffOperationPatientScope(client, handle, "finance.invoices.create");
          if (
            pScope.kind === "own" &&
            !(await patientInDoctorScopeWith(client, pScope.clinicianPartyId, ownerRow.patient_id))
          ) {
            throw new InvoiceAddServiceError("unauthorized", "غير مصرّح لك بالوصول لهذا الملف.");
          }
        }
        return addCanonicalInvoiceServiceInTx(client, id, body, {
          userId: identity.userId,
          username: identity.username,
          role: identity.role,
          canDocumentLabWork: caps.has("clinical.lab.order"),
          capabilities: {
            canIncreasePrice: caps.has("finance.price-increases.apply"),
            canApplyDiscount: caps.has("finance.discounts.apply"),
            canOverrideDiscount: caps.has("finance.discounts.override"),
          },
          verifyLiveSession: async (c: DbClient) => {
            await assertStaffOperation(c, handle, "finance.invoices.create");
          },
        });
      },
    );
    if ("committedRejection" in outcome) {
      return invoiceAddServiceFailure(outcome.committedRejection);
    }
    return NextResponse.json(outcome.receipt, { status: outcome.receipt.replayed ? 200 : 201 });
  } catch (error) {
    return invoiceAddServiceFailure(error);
  }
}

function invoiceArchiveFailure(error: unknown, fallbackMessage: string): NextResponse {
  const bounded = bodyErrorResponse(error);
  if (bounded) return bounded;
  if (error instanceof InvoiceArchiveError) {
    return NextResponse.json(
      { code: error.code, message: error.message, ...(error.refusal ? { refusal: error.refusal } : {}) },
      {
        status:
          error.code === "unauthorized"
            ? 403
            : error.code === "missing"
              ? 404
              : error.code === "invalid"
                ? 400
                : 409,
        headers: NO_STORE,
      },
    );
  }
  return handleSlice37aError(error, fallbackMessage);
}

export async function invoiceArchiveGetCanonicalResponse(
  idRaw: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const id = parsePositiveId(idRaw);
  if (!id) {
    return invoiceArchiveFailure(
      new InvoiceArchiveError("invalid", "رقم الفاتورة غير صالح."),
      "تعذّر تأكيد حالة الأرشفة؛ احتفظ بالطلب نفسه وأعد التحقق.",
    );
  }
  try {
    const view = await runCanonicalReadSnapshot(
      session,
      "finance.invoices.view",
      async (query, scope) => {
        const result = await readCanonicalInvoiceArchiveWith(query, id);
        if (
          scope.patientScope.kind === "own" &&
          !(await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, result.patientId))
        ) {
          throw new InvoiceArchiveError("unauthorized", "غير مصرّح لك بالوصول لهذا الملف.");
        }
        return result;
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(view, { headers: NO_STORE });
  } catch (error) {
    return invoiceArchiveFailure(error, "تعذّر تأكيد حالة الأرشفة؛ احتفظ بالطلب نفسه وأعد التحقق.");
  }
}

export async function invoiceArchivePostCanonicalResponse(
  request: Request,
  idRaw: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const id = parsePositiveId(idRaw);
  if (!id) {
    return invoiceArchiveFailure(
      new InvoiceArchiveError("invalid", "رقم الفاتورة غير صالح."),
      "تعذّر تأكيد حالة الأرشفة؛ احتفظ بالطلب نفسه وأعد التحقق.",
    );
  }
  try {
    const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "finance.invoices.cancel",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.invoices.cancel");
        const ownerRow = (
          await client.query<{ patient_id: number }>("SELECT patient_id FROM invoices WHERE id = $1", [id])
        ).rows[0];
        if (ownerRow) {
          const pScope = await staffOperationPatientScope(client, handle, "finance.invoices.cancel");
          if (
            pScope.kind === "own" &&
            !(await patientInDoctorScopeWith(client, pScope.clinicianPartyId, ownerRow.patient_id))
          ) {
            throw new InvoiceArchiveError("unauthorized", "غير مصرّح لك بالوصول لهذا الملف.");
          }
        }
        return changeCanonicalInvoiceArchiveInTx(client, id, body, {
          userId: identity.userId,
          username: identity.username,
          role: identity.role,
          verifyLiveSession: async (c: DbClient) => {
            await assertStaffOperation(c, handle, "finance.invoices.cancel");
          },
        });
      },
    );
    if ("committedRejection" in outcome) {
      return invoiceArchiveFailure(
        outcome.committedRejection,
        "تعذّر تأكيد حالة الأرشفة؛ احتفظ بالطلب نفسه وأعد التحقق.",
      );
    }
    return NextResponse.json(outcome.result, {
      status: outcome.result.replayed || outcome.result.noop ? 200 : 201,
    });
  } catch (error) {
    return invoiceArchiveFailure(error, "تعذّر تأكيد حالة الأرشفة؛ احتفظ بالطلب نفسه وأعد التحقق.");
  }
}

export async function invoiceArchiveListCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));
  if (!Number.isSafeInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  }
  try {
    const list = await runCanonicalReadSnapshot(
      session,
      "finance.invoices.view",
      async (query, scope) => {
        if (
          scope.patientScope.kind === "own" &&
          !(await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, patientId))
        ) {
          throw new InvoiceArchiveError("unauthorized", "غير مصرّح لك بالوصول لهذا الملف.");
        }
        return listCanonicalInvoiceArchiveWith(query, patientId);
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(list, { headers: NO_STORE });
  } catch (error) {
    return invoiceArchiveFailure(error, "تعذّر تحميل أرشيف الفواتير.");
  }
}

function invoiceCorrectFailure(error: unknown): NextResponse {
  const bounded = bodyErrorResponse(error);
  if (bounded) return bounded;
  if (error instanceof DebtRepaymentError) {
    return NextResponse.json(
      { message: error.message, code: error.code },
      {
        status:
          error.code === "unauthorized"
            ? 403
            : error.code === "missing"
              ? 404
              : error.code === "invalid"
                ? 400
                : 409,
        headers: NO_STORE,
      },
    );
  }
  return handleSlice37aError(error, "تعذّر تأكيد التصحيح. أعد الطلب نفسه للتحقق من النتيجة.");
}

export async function invoiceCorrectGetCanonicalResponse(
  idRaw: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const id = parsePositiveId(idRaw);
  if (!id) return invoiceCorrectFailure(new DebtRepaymentError("invalid", "رقم الفاتورة غير صالح."));
  try {
    const view = await runCanonicalReadSnapshot(
      session,
      "finance.invoices.correct",
      async (query, scope) => {
        const result = await readCanonicalInvoiceRevisionWith(query, id);
        if (
          scope.patientScope.kind === "own" &&
          !(await patientInDoctorScopeWith(
            query,
            scope.patientScope.clinicianPartyId,
            result.invoice.patientId,
          ))
        ) {
          throw new DebtRepaymentError("unauthorized", "غير مصرّح لك بالوصول لهذا الملف.");
        }
        return result;
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(view, { headers: NO_STORE });
  } catch (error) {
    return invoiceCorrectFailure(error);
  }
}

export async function invoiceCorrectPostCanonicalResponse(
  request: Request,
  idRaw: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const id = parsePositiveId(idRaw);
  if (!id) return invoiceCorrectFailure(new DebtRepaymentError("invalid", "رقم الفاتورة غير صالح."));
  try {
    const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new DebtRepaymentError("invalid", "طلب التصحيح غير صالح.");
    }
    const result = await withStaffOperation(
      getPool(),
      session,
      "finance.invoices.correct",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.invoices.correct");
        const ownerRow = (
          await client.query<{ patient_id: number }>("SELECT patient_id FROM invoices WHERE id = $1", [id])
        ).rows[0];
        if (ownerRow) {
          const pScope = await staffOperationPatientScope(client, handle, "finance.invoices.correct");
          if (
            pScope.kind === "own" &&
            !(await patientInDoctorScopeWith(client, pScope.clinicianPartyId, ownerRow.patient_id))
          ) {
            throw new DebtRepaymentError("unauthorized", "غير مصرّح لك بالوصول لهذا الملف.");
          }
        }
        return reviseCanonicalInvoiceInTx(client, id, body as Record<string, unknown>, {
          userId: identity.userId,
          username: identity.username,
          role: identity.role,
          verifyLiveSession: async (c: DbClient) => {
            await assertStaffOperation(c, handle, "finance.invoices.correct");
          },
        });
      },
    );
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return invoiceCorrectFailure(error);
  }
}

export async function invoiceClinicalPreviewCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = ((await readJsonBody(request, JSON_BODY_LIMIT_BYTES)) ?? {}) as Record<string, unknown>;
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  try {
    const preview = await runCanonicalReadSnapshot(
      session,
      "read:invoices.clinical-preview",
      async (query, scope) => {
        if (hasInvoiceLabWork(body) && !scope.granted("clinical.visits.document")) {
          throw new CanonicalSlice37aRefusal(403, "وصفة المختبر السريرية للطبيب والإدارة فقط.");
        }
        const services = new Map((await listServicesWith(query, true)).map((s) => [s.id, s]));
        const doctors = new Set((await listPartiesWith(query, "doctor")).map((p) => p.id));
        const settings = await getSettingsInTransaction(query as DbClient, {
          requireStoredExchangeRates: true,
        });
        const parsed = parseInvoiceCommand(body, services, doctors, settings, false);
        if (!parsed.ok) {
          return {
            ok: false as const,
            status: parsed.status ?? 400,
            body: { message: parsed.message, ...(parsed.code ? { code: parsed.code } : {}) },
          };
        }
        if (
          scope.patientScope.kind === "own" &&
          !(await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, parsed.patientId))
        ) {
          throw new CanonicalSlice37aRefusal(403, "غير مصرّح لك بالوصول لهذا الملف.");
        }
        const authority = checkInvoiceAuthority({
          requireInvoiceManualReason: true,
          lines: parsed.authorityLines,
          currency: parsed.baseCurrency,
          rates: foreignRatesFromSettings(settings),
          role: scope.role,
          capabilities: {
            canIncreasePrice: scope.granted("finance.price-increases.apply"),
            canApplyDiscount: scope.granted("finance.discounts.apply"),
            canOverrideDiscount: scope.granted("finance.discounts.override"),
          },
          maxDiscountPercent: Number(settings["billing.max_discount_percent"]),
          totalMinor: parsed.items.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0),
          discountMinor: parsed.discountMinor,
          discountReason: typeof body.discountReason === "string" ? body.discountReason : null,
        });
        if (!authority.ok) {
          return {
            ok: false as const,
            status: authority.forbidden ? 403 : 400,
            body: { message: authority.message },
          };
        }
        const lines = await previewInvoiceLinkage(
          {
            patientId: parsed.patientId,
            baseCurrency: parsed.baseCurrency,
            existingPlanId: parsed.existingPlanId,
            items: parsed.items,
          },
          query as DbClient,
        );
        const planChoices = await invoicePlanChoices(query, parsed.patientId, parsed.baseCurrency);
        const supported = await labWorkIntentSupported(query);
        const labByPlan = supported
          ? await readLabWorkForPlanItems(
              query,
              parsed.patientId,
              parsed.items.flatMap((item) => (item.planItemId ? [item.planItemId] : [])),
            )
          : new Map();
        return {
          ok: true as const,
          status: 200,
          body: {
            labWorkIntentSupported: supported,
            template: parsed.template,
            existingPlanId: parsed.existingPlanId,
            planChoices,
            lines: lines.map((line, index) => ({
              ...line,
              ...(parsed.items[index]?.planItemId &&
              !line.refusal &&
              line.item?.mode === "existing" &&
              line.item.id === parsed.items[index].planItemId
                ? labByPlan.get(parsed.items[index].planItemId!) ?? {}
                : {}),
              refusalMessage: line.refusal ? INVOICE_LINKAGE_MESSAGE[line.refusal] : null,
            })),
          },
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(preview.body, { status: preview.status, headers: NO_STORE });
  } catch (error) {
    return handleSlice37aError(error, "تعذّرت معاينة الربط السريري.");
  }
}

/* ============================================================================
 * 2. PAYMENTS (/api/payments/**)
 * ============================================================================ */

export async function paymentsListCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const requested = new URL(request.url).searchParams.get("date") ?? "";
  const date = DATE_PATTERN.test(requested) ? requested : clinicDateString(new Date(), CLINIC_TIME_ZONE);
  try {
    const payments = await runCanonicalReadSnapshot(
      session,
      "finance.payments.view",
      async (query, scope) => {
        const list = await listPaymentsByDateWith(query, date);
        if (scope.patientScope.kind !== "own") return list;
        const filtered = [];
        const allowedCache = new Map<number, boolean>();
        for (const p of list) {
          let allowed = allowedCache.get(p.patientId);
          if (allowed === undefined) {
            allowed = await patientInDoctorScopeWith(
              query,
              scope.patientScope.clinicianPartyId,
              p.patientId,
            );
            allowedCache.set(p.patientId, allowed);
          }
          if (allowed) filtered.push(p);
        }
        return filtered;
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json({ date, payments }, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37aError(error, "تعذّر تحميل المقبوضات.");
  }
}

export async function paymentsCreateCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const similarityReview = parseSimilarCollectionReviewHeader(
    request.headers.get(SIMILAR_COLLECTION_REVIEW_HEADER),
  );
  if (!similarityReview) {
    return NextResponse.json(
      { message: "مراجعة السندات المشابهة المرسلة غير صالحة. أعد فتح نافذة التحصيل." },
      { status: 400 },
    );
  }

  const recovery = parseRecoveryIntent(body, request.headers.get("idempotency-key"));
  if (recovery.kind === "invalid") {
    return NextResponse.json(
      {
        reason: "invalid_recovery_request",
        message:
          "طلب إعادة تحصيل القسط غير صالح. اختر الفاتورة الأصلية ومبلغًا ومفتاح إعادة صالحين دون أهداف أو أسعار صرف إضافية.",
      },
      { status: 400 },
    );
  }

  if (recovery.kind === "recovery") {
    try {
      const outcome = await withStaffOperation(
        getPool(),
        session,
        "finance.payments.collect",
        async (client, handle) => {
          const identity = await staffOperationIdentity(client, handle, "finance.payments.collect");
          const pScope = await staffOperationPatientScope(client, handle, "finance.payments.collect");
          if (
            pScope.kind === "own" &&
            !(await patientInDoctorScopeWith(client, pScope.clinicianPartyId, recovery.intent.patientId))
          ) {
            throw new CanonicalSlice37aRefusal(403, "غير مصرّح لك بالوصول لهذا الملف.");
          }
          const result = await recordReversedInstallmentRecoveryInTx(
            client,
            {
              ...recovery.intent,
              idempotencyKey: recovery.idempotencyKey,
              createdBy: identity.username,
              actorRole: identity.role,
            },
            { similarityReview },
          );
          if (result.reason || !result.payment) {
            const messages: Record<string, string> = {
              invalid_recovery_request: "طلب إعادة تحصيل القسط غير صالح.",
              recovery_review_required:
                "ربط القسط المعكوس يحتاج مراجعة المدير قبل التحصيل. لا تُصدر قسطًا جديدًا بدلًا منه.",
              recovery_not_available:
                "لم تعد هذه الفاتورة متاحة لإعادة التحصيل. حدّث الحساب واختر هدفًا صالحًا.",
              recovery_exceeds_remaining:
                "المبلغ يتجاوز المتبقي على الفاتورة الأصلية. حدّث الحساب وراجع المبلغ.",
              recovery_account_credit_review:
                "المبلغ يتجاوز المستحق الفعلي على الحساب بهذه العملة أو يوجد رصيد دائن. راجع التسويات مع المدير قبل قبض المال؛ لا تُصدر قسطًا جديدًا.",
              recovery_target_changed:
                "تغيّر ربط الفاتورة الأصلية أثناء التحصيل. حدّث الحساب وراجع الهدف.",
              exchange_rate_required:
                "سعر الصرف غير مضبوط. اضبطه في الإعدادات قبل قبض عملة أجنبية.",
              idempotency_conflict: "مفتاح الإعادة مستعمل بعملية مختلفة — مفتاح واحد لعملية واحدة.",
              no_shift: "لا توجد وردية مفتوحة. افتح الوردية من شاشة المالية أولًا.",
              invalid_invoice: "الفاتورة لا تخص المريض أو غير صالحة.",
              cross_currency_not_supported:
                "حصّل الفاتورة بعملتها نفسها؛ التسوية بهذه العملة غير مدعومة.",
            };
            return {
              status: result.reason === "invalid_recovery_request" ? 400 : 409,
              body: {
                reason: result.reason,
                message:
                  messages[result.reason ?? ""] ??
                  "تعذّرت إعادة تحصيل القسط. راجع الحساب قبل المحاولة.",
              },
            };
          }
          return {
            status: result.replayed ? 200 : 201,
            body: { ...result.payment, idempotencyKey: recovery.idempotencyKey },
          };
        },
      );
      return NextResponse.json(outcome.body, { status: outcome.status });
    } catch (error) {
      if (error instanceof SimilarCollectionReviewRequired) {
        return NextResponse.json(similarCollectionRefusal(error), { status: 409 });
      }
      if (isRetiredCollectionKey(error)) {
        return NextResponse.json(retiredCollectionRefusal(), { status: 409 });
      }
      return handleSlice37aError(error, "تعذّر تسجيل الدفعة. أعد المحاولة بالمفتاح نفسه.");
    }
  }

  const kind = source.kind === "refund" ? "refund" : "payment";
  const action = kind === "refund" ? "finance.payments.refund" : "finance.payments.collect";

  try {
    const outcome = await withStaffOperation(getPool(), session, action, async (client, handle) => {
      const identity = await staffOperationIdentity(client, handle, action);

      const patientId = Number(source.patientId);
      if (!Number.isInteger(patientId) || patientId <= 0) {
        return { status: 400, body: { message: "اختر المريض أولًا." } };
      }

      const pScope = await staffOperationPatientScope(client, handle, action);
      if (
        pScope.kind === "own" &&
        !(await patientInDoctorScopeWith(client, pScope.clinicianPartyId, patientId))
      ) {
        throw new CanonicalSlice37aRefusal(403, "غير مصرّح لك بالوصول لهذا الملف.");
      }

      const currency = source.currency;
      if (!isCurrency(currency)) {
        return { status: 400, body: { message: "اختر العملة." } };
      }

      const amountMinor = parseAmount(String(source.amount ?? ""), currency);
      if (amountMinor === null || amountMinor === 0) {
        return { status: 400, body: { message: "اكتب مبلغًا أكبر من صفر." } };
      }

      const method = source.method === "transfer" ? "transfer" : "cash";
      const invoiceIdRaw = Number(source.invoiceId);
      const invoiceId = Number.isInteger(invoiceIdRaw) && invoiceIdRaw > 0 ? invoiceIdRaw : null;
      const planIdRaw = Number(source.planId);
      const planId = Number.isInteger(planIdRaw) && planIdRaw > 0 ? planIdRaw : null;
      const openingCurrency = isCurrency(source.openingCurrency) ? source.openingCurrency : null;
      const note =
        typeof source.note === "string" && source.note.trim()
          ? source.note.trim().slice(0, 300)
          : null;

      if ([invoiceId, planId, openingCurrency].filter((target) => target !== null).length > 1) {
        return {
          status: 400,
          body: { message: "هدفٌ واحد للدفعة: فاتورة أو خطة أو رصيد سابق — لا أكثر من واحد." },
        };
      }

      if (
        kind === "payment" &&
        invoiceId === null &&
        planId === null &&
        openingCurrency === null &&
        currency !== CLINIC_BASE_CURRENCY
      ) {
        return {
          status: 400,
          body: {
            message:
              "الدفعة بعملة أجنبية تتطلب هدفًا صريحًا (فاتورة أو خطة أو رصيد سابق بعملتها) — لا تُقيَّد على الحساب بالعملة الأساسية بصمت.",
          },
        };
      }

      const idempotencyKeyRaw = request.headers.get("idempotency-key");
      const idempotencyKey =
        idempotencyKeyRaw && idempotencyKeyRaw.trim() ? idempotencyKeyRaw.trim() : null;
      if (!idempotencyKey) {
        return {
          status: 400,
          body: {
            reason: "idempotency_key_required",
            message:
              "مفتاح الإعادة (Idempotency-Key) مطلوب للتحصيل. أعد إرسال الطلب المحفوظ بالمفتاح نفسه.",
          },
        };
      }
      if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        return {
          status: 400,
          body: {
            message:
              "مفتاح الإعادة (Idempotency-Key) غير صالح: ٨–١٢٨ محرفًا من حروف وأرقام و . _ : -",
          },
        };
      }

      const reversalOfRaw = Number(source.reversalOfId);
      const reversalOfId =
        Number.isInteger(reversalOfRaw) && reversalOfRaw > 0 ? reversalOfRaw : null;

      if (kind === "refund" && reversalOfId === null) {
        return {
          status: 400,
          body: { message: "الردّ يتطلب تحديد السند الأصلي (reversalOfId) — لا يُردّ مال بلا أصل." },
        };
      }

      const settings = await getSettingsInTransaction(client);
      const base = CLINIC_BASE_CURRENCY;
      const savedPayment = await getPaymentByIdempotencyKeyWith(client, idempotencyKey);
      const exchangeRate =
        savedPayment?.patientId === patientId &&
        savedPayment.createdBy === identity.username &&
        savedPayment.currency === currency
          ? savedPayment.exchangeRate
          : rateFromSettings(settings, currency, base);
      const exchangeRateRequired = (includeReason = false) => ({
        status: 409 as const,
        body: {
          ...(includeReason ? { reason: "exchange_rate_required" } : {}),
          message: "سعر الصرف غير مضبوط. اضبطه في الإعدادات قبل قبض عملة أجنبية.",
        },
      });

      if (kind === "payment" && planId !== null) {
        if (await isPlanFundedByAgreementWith(client, planId, patientId)) {
          if (exchangeRate === null) return exchangeRateRequired();
          const plan = await getPlanWith(client, planId, clinicDateString(new Date(), CLINIC_TIME_ZONE));
          if (plan && plan.patientId === patientId) {
            if (plan.approvedAgreement) {
              const rawResult = await collectCanonicalApprovedAgreementInTransaction(
                client,
                handle,
                "finance.payments.collect",
                {
                  planId,
                  amountMinor,
                  currency,
                  method: method === "transfer" ? "transfer" : "cash",
                  note,
                  idempotencyKey,
                },
                { similarityReview, enforcePatientScope: pScope.kind === "own" },
              );
              const result = await hydrateCollectedAgreementPayments(rawResult, client);
              const split =
                "collection" in result &&
                result.collection &&
                "payments" in result &&
                Array.isArray(result.payments);
              return {
                status: result.replayed ? 200 : 201,
                body: {
                  ...result.payment,
                  idempotencyKey,
                  ...(split
                    ? {
                        collection: {
                          kind: "approved_agreement_split_v1",
                          ...result.collection,
                          receipts: result.payments,
                        },
                        paymentIds: result.paymentIds,
                        allocations: result.collection.allocations,
                        collectionAmountMinor: result.collection.amountMinor,
                      }
                    : {}),
                },
              };
            }

            const installmentNumber = Math.min(
              plan.progress.paidCount + 1,
              plan.installments.length || 1,
            );
            await client.query("SAVEPOINT canonical_plan_installment");
            let result: Awaited<ReturnType<typeof recordPlanInstallmentInTransaction>>;
            try {
              result = await recordPlanInstallmentInTransaction(client, {
                planId,
                patientId,
                installmentNumber,
                planTitle: plan.title,
                amountMinor,
                currency,
                baseCurrency: base,
                exchangeRate,
                method,
                note,
                createdBy: identity.username,
                actorRole: identity.role,
                idempotencyKey,
                similarityReview,
              });
            } catch (error) {
              await client.query("ROLLBACK TO SAVEPOINT canonical_plan_installment").catch(() => undefined);
              await client.query("RELEASE SAVEPOINT canonical_plan_installment").catch(() => undefined);
              if (error instanceof FinancialCurrencyIntegrityError) {
                result = { reason: "installment_recovery_review_required" };
              } else {
                throw error;
              }
            }
            if ("reason" in result) {
              await client.query("ROLLBACK TO SAVEPOINT canonical_plan_installment").catch(() => undefined);
              await client.query("RELEASE SAVEPOINT canonical_plan_installment").catch(() => undefined);
              const messages = {
                inactive_plan: "الخطة غير جارية — لا يمكن تسجيل تحصيل جديد عليها.",
                no_shift: "لا توجد وردية مفتوحة. افتح الوردية من شاشة المالية أولًا.",
                cross_currency_not_supported: `القسط بعملةٍ مختلفة عن عملة الخطة (${plan.baseCurrency}) غير مدعوم — حصّل بعملة الاتفاق نفسها.`,
                idempotency_conflict: "مفتاح الإعادة مستعمل بعملية مختلفة — مفتاح واحد لعملية واحدة.",
                issued_installment_recovery_required:
                  "يوجد قسط مُصدر عُكس قبضه. اختر إعادة تحصيل الفاتورة الأصلية من الحساب؛ لا تُصدر قسطًا جديدًا.",
                plan_financial_history_requires_review:
                  "الخطة تحتوي علاجًا ذا سجل مالي أو اتفاق تاريخي؛ لا تُصدر قسطًا جديدًا له. اختر الفاتورة القائمة أو الرصيد السابق وراجع الربط المالي.",
                installment_recovery_review_required:
                  "يوجد قسط مُصدر يحتاج مراجعة ربطه قبل التحصيل. راجع المدير؛ لا تُصدر فاتورة بديلة.",
              } as const;
              return {
                status: 409,
                body: {
                  reason: result.reason,
                  message: messages[result.reason],
                  ...("recoveryInvoiceIds" in result
                    ? { recoveryInvoiceIds: result.recoveryInvoiceIds }
                    : {}),
                },
              };
            }
            await client.query("RELEASE SAVEPOINT canonical_plan_installment");
            const payment = await getPaymentWith(client, result.paymentId);
            return {
              status: result.replayed ? 200 : 201,
              body: { ...payment, idempotencyKey },
            };
          }
        }
      }

      if (kind === "payment" && reversalOfId !== null) {
        return {
          status: 409,
          body: { message: "السند المُراد ردّه غير موجود، أو لا يخص المريض، أو ليس دفعة أصلية." },
        };
      }

      if (kind === "refund" && exchangeRate === null) return exchangeRateRequired();
      const receiptInput = {
        patientId,
        invoiceId,
        planId,
        openingCurrency,
        amountMinor,
        currency,
        baseCurrency: base,
        method,
        note,
        createdBy: identity.username,
        idempotencyKey,
        actorRole: identity.role,
      };
      const result =
        kind === "payment"
          ? await recordSettingsOwnedPaymentInTx(
              client,
              { ...receiptInput, similarityReview },
              settings,
            )
          : await recordPaymentInTx(client, {
              ...receiptInput,
              kind,
              exchangeRate: exchangeRate!,
              reversalOfId,
            });
      const { payment, reason, replayed } = result;
      const acknowledgmentEvidence =
        "acknowledgmentEvidence" in result ? result.acknowledgmentEvidence : undefined;
      if (reason === "exchange_rate_required") return exchangeRateRequired(true);
      if (
        reason === "issued_installment_recovery_required" ||
        reason === "installment_recovery_review_required"
      ) {
        return {
          status: 409,
          body: {
            reason,
            message:
              reason === "issued_installment_recovery_required"
                ? "يوجد قسط معكوس بفاتورته الأصلية. لم يُسجّل قبض جديد؛ يلزم مسار إعادة تحصيل الفاتورة الأصلية. لا تكرر القبض أو تُصدر قسطًا جديدًا."
                : "تاريخ القسط المعكوس يحتاج مراجعة المدير. لم يُسجّل قبض جديد؛ لا تكرر التحصيل أو تُصدر قسطًا آخر.",
          },
        };
      }
      if (reason === "invalid_invoice") {
        return { status: 409, body: { message: "الفاتورة لا تخص المريض أو غير صالحة." } };
      }
      if (reason === "inactive_plan") {
        return { status: 409, body: { message: "الخطة غير جارية — لا يمكن تسجيل تحصيل جديد عليها." } };
      }
      if (reason === "invalid_plan_target") {
        return {
          status: 409,
          body: {
            message:
              "الخطة غير متاحة كهدف لتحصيل جديد؛ تأكد من المريض واختر الفاتورة القائمة أو الرصيد السابق للعلاج التاريخي.",
          },
        };
      }
      if (reason === "invalid_opening_target") {
        return { status: 409, body: { message: "لا يوجد على المريض رصيد سابق بهذه العملة." } };
      }
      if (reason === "reversal_target_conflict") {
        return {
          status: 409,
          body: {
            message:
              "هدف التسوية المرسل يخالف هدف السند الأصلي — الردّ يسوّي حيث سُدِّد الأصل، لا حيث يقول الطلب.",
          },
        };
      }
      if (reason === "multiple_payment_targets") {
        return {
          status: 400,
          body: { message: "هدفٌ واحد للدفعة: فاتورة أو خطة أو رصيد سابق — لا أكثر من واحد." },
        };
      }
      if (reason === "foreign_on_account_requires_target") {
        return {
          status: 400,
          body: {
            message:
              "الدفعة بعملة أجنبية تتطلب هدفًا صريحًا (فاتورة أو خطة) — لا تُقيَّد على الحساب بالعملة الأساسية بصمت.",
          },
        };
      }
      if (reason === "invalid_reversal") {
        return {
          status: 409,
          body: { message: "السند المُراد ردّه غير موجود، أو لا يخص المريض، أو ليس دفعة أصلية." },
        };
      }
      if (reason === "cross_currency_not_supported") {
        return {
          status: 409,
          body: {
            message:
              "الدفع بعملةٍ مختلفة عن فاتورةٍ أو رصيدٍ بعملة اتفاق (SAR/USD) غير مدعوم — سدّد بعملته نفسها.",
          },
        };
      }
      if (reason === "reversal_currency_mismatch") {
        return {
          status: 409,
          body: { message: "الردّ يجب أن يكون بعملة السند الأصلي نفسها — لا ردّ بعملة مختلفة." },
        };
      }
      if (reason === "refund_snapshot_review_required") {
        return {
          status: 409,
          body: {
            reason,
            message:
              "تعذّر إثبات الردّ بما يحافظ على تسوية السند الأصلية. يلزم مراجعة المدير؛ لم يُسجّل أي ردّ جديد.",
          },
        };
      }
      if (reason === "reversal_exceeds_remaining") {
        return {
          status: 409,
          body: {
            message:
              "المبلغ يتجاوز المتبقي القابل للرد من السند الأصلي — مجموع الردود لا يتخطى مبلغ الأصل.",
          },
        };
      }
      if (reason === "idempotency_conflict") {
        return {
          status: 409,
          body: { message: "مفتاح الإعادة مستعمل بعملية مختلفة — مفتاح واحد لعملية واحدة." },
        };
      }
      if (reason === "no_shift") {
        return {
          status: 409,
          body: { message: "لا توجد وردية مفتوحة. افتح الوردية من شاشة المالية أولًا." },
        };
      }
      if (payment && replayed) {
        await insertAuditRow(client, {
          action: "payment.idempotent_replay",
          entity: "payment",
          entityId: payment.id,
          entityLabel: payment.receiptNumber,
          details: { المريض: patientId, مفتاح_الإعادة: idempotencyKey },
          actor: identity.username,
          actorRole: identity.role,
        });
      }
      return {
        status: replayed ? 200 : 201,
        body: {
          ...payment,
          idempotencyKey,
          ...(acknowledgmentEvidence ? { acknowledgmentEvidence } : {}),
        },
      };
    });
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error) {
    if (error instanceof SimilarCollectionReviewRequired) {
      return NextResponse.json(similarCollectionRefusal(error), { status: 409 });
    }
    if (isRetiredCollectionKey(error)) {
      return NextResponse.json(retiredCollectionRefusal(), { status: 409 });
    }
    if (error instanceof DebtRepaymentError) {
      return NextResponse.json(
        { message: error.message, code: error.code },
        { status: error.code === "unauthorized" ? 403 : error.code === "invalid" ? 400 : 409 },
      );
    }
    return handleSlice37aError(error, "تعذّر تسجيل الدفعة. أعد المحاولة.");
  }
}

const CORRECT_PAYMENT_MESSAGES: Record<CorrectPaymentRefusal, { status: number; message: string }> = {
  missing_reason: { status: 400, message: "اكتب سبب التصحيح (٣ أحرف على الأقل)." },
  not_found: { status: 404, message: "السند غير موجود." },
  not_a_receipt: { status: 409, message: "هذا سند ردّ — يُصحَّح سند القبض الأصلي لا ردُّه." },
  already_reversed: { status: 409, message: "هذا السند معكوسٌ بالكامل سلفًا — لا شيء يُصحَّح فيه." },
  no_shift: {
    status: 409,
    message: "لا توجد وردية مفتوحة. افتح الوردية من شاشة المالية أولًا — التصحيح يمرّ بالدرج.",
  },
  invalid_invoice: { status: 409, message: "الفاتورة المختارة لا تخص المريض أو غير صالحة." },
  inactive_plan: { status: 409, message: "الخطة غير جارية — لا يمكن تسجيل تحصيل جديد عليها." },
  invalid_plan_target: { status: 409, message: "الخطة غير موجودة أو لا تخص المريض." },
  invalid_opening_target: { status: 409, message: "لا يوجد على المريض رصيد سابق بهذه العملة." },
  invalid_reversal: { status: 409, message: "تعذّر عكس السند الأصلي." },
  reversal_currency_mismatch: { status: 409, message: "العكس يكون بعملة السند الأصلي نفسها." },
  reversal_target_conflict: { status: 409, message: "العكس يسوّي حيث سُدِّد الأصل." },
  multiple_payment_targets: {
    status: 400,
    message: "هدفٌ واحد للسند الصحيح: فاتورة أو خطة أو رصيد سابق.",
  },
  foreign_on_account_requires_target: {
    status: 400,
    message: "السند بعملة أجنبية يتطلب فاتورة أو خطة أو رصيدًا سابقًا بعملتها.",
  },
  cross_currency_not_supported: {
    status: 409,
    message:
      "الدفع بعملةٍ مختلفة عن فاتورةٍ أو رصيدٍ بعملة اتفاق (SAR/USD) غير مدعوم — سدّد بعملته نفسها.",
  },
  refund_snapshot_review_required: {
    status: 409,
    message:
      "تعذّر إثبات الردّ بما يحافظ على تسوية السند الأصلية. يلزم مراجعة المدير؛ لم يثبت أي تصحيح.",
  },
  reversal_exceeds_remaining: {
    status: 409,
    message: "المتبقي من السند تغيّر أثناء التصحيح — أعد فتح السند وحاول مجددًا.",
  },
  idempotency_conflict: { status: 409, message: "مفتاح الإعادة مستعمل بعملية مختلفة." },
  issued_installment_recovery_required: {
    status: 409,
    message:
      "هذا قسط معكوس له فاتورته الأصلية. اختر هدف السند الأصلي أو مسار إعادة التحصيل؛ لم يثبت التصحيح.",
  },
  installment_recovery_review_required: {
    status: 409,
    message: "تاريخ القسط المعكوس يحتاج مراجعة المدير قبل التصحيح؛ لم يثبت أي سند.",
  },
};

export async function paymentCorrectCanonicalResponse(
  request: Request,
  idRaw: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const paymentId = parsePositiveId(idRaw);
  if (!paymentId) return NextResponse.json({ message: "رقم السند غير صالح." }, { status: 400 });

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const reason = typeof source.reason === "string" ? source.reason.trim().slice(0, 300) : "";
  if (reason.length < 3) {
    return NextResponse.json(CORRECT_PAYMENT_MESSAGES.missing_reason, { status: 400 });
  }
  const mode = source.mode === "void" ? "void" : "correct";
  const idempotencyKeyRaw = request.headers.get("idempotency-key");
  const idempotencyKey =
    idempotencyKeyRaw && /^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKeyRaw.trim())
      ? idempotencyKeyRaw.trim()
      : null;

  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "finance.payments.void",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.payments.void");
        if (mode === "correct") {
          const caps = await staffOperationCapabilities(
            client,
            handle,
            "finance.payments.void",
            ["finance.payments.collect"] as const,
          );
          if (!caps.has("finance.payments.collect")) {
            throw new CanonicalSlice37aRefusal(
              403,
              "إصدار السند البديل يتطلب صلاحية التحصيل إلى جانب صلاحية الإبطال.",
            );
          }
        }

        let replacement: Parameters<typeof correctPaymentInTx>[1]["replacement"] = null;
        let acknowledgmentRate: number | null = null;
        if (mode === "correct") {
          const currency = source.currency;
          if (!isCurrency(currency)) {
            return { status: 400, body: { message: "اختر عملة السند الصحيح." } };
          }
          const amountMinor = parseAmount(String(source.amount ?? ""), currency);
          if (amountMinor === null || amountMinor <= 0) {
            return { status: 400, body: { message: "اكتب مبلغ السند الصحيح أكبر من صفر." } };
          }
          const saved = idempotencyKey
            ? await getPaymentByIdempotencyKeyWith(client, idempotencyKey)
            : null;
          const original = saved ? await getPaymentWith(client, paymentId) : null;
          const settings = await getSettingsInTransaction(client);
          const usesSavedRate =
            saved &&
            saved.patientId === original?.patientId &&
            saved.createdBy === identity.username &&
            saved.currency === currency;
          const exchangeRate = usesSavedRate
            ? saved.exchangeRate
            : rateFromSettings(settings, currency, CLINIC_BASE_CURRENCY);
          acknowledgmentRate = usesSavedRate
            ? rateFromSettings(settings, currency, CLINIC_BASE_CURRENCY)
            : exchangeRate;
          if (exchangeRate === null) {
            return {
              status: 409,
              body: { message: "سعر الصرف غير مضبوط. اضبطه في الإعدادات قبل قبض عملة أجنبية." },
            };
          }
          let target: CorrectionTarget;
          if (source.target === "original") {
            target = { kind: "original" };
          } else {
            const invoiceIdRaw = Number(source.invoiceId);
            const planIdRaw = Number(source.planId);
            target = {
              kind: "explicit",
              invoiceId: Number.isInteger(invoiceIdRaw) && invoiceIdRaw > 0 ? invoiceIdRaw : null,
              planId: Number.isInteger(planIdRaw) && planIdRaw > 0 ? planIdRaw : null,
              openingCurrency: isCurrency(source.openingCurrency) ? source.openingCurrency : null,
            };
          }
          replacement = {
            amountMinor,
            currency,
            exchangeRate,
            method: source.method === "transfer" ? "transfer" : "cash",
            target,
          };
        }

        const result = await correctPaymentInTx(
          client,
          {
            paymentId,
            reason,
            actor: identity.username,
            actorRole: identity.role,
            idempotencyKey,
            replacement,
          },
          { observedExchangeRate: acknowledgmentRate },
        );
        if (result.reason !== null) {
          const refusal = CORRECT_PAYMENT_MESSAGES[result.reason];
          return { status: refusal.status, body: { message: refusal.message } };
        }
        return {
          status: result.replayed ? 200 : 201,
          body: {
            original: result.original,
            reversal: result.reversal,
            replacement: result.replacement,
            replayed: result.replayed,
            idempotencyKey,
            ...(result.acknowledgmentEvidence
              ? { acknowledgmentEvidence: result.acknowledgmentEvidence }
              : {}),
          },
        };
      },
    );
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error) {
    if (error instanceof DebtRepaymentError) {
      return NextResponse.json(
        { message: error.message, code: error.code },
        { status: error.code === "unauthorized" ? 403 : error.code === "invalid" ? 400 : 409 },
      );
    }
    return handleSlice37aError(error, "تعذّر تصحيح السند. أعد المحاولة.");
  }
}

export async function paymentAttemptRetireCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    const fields =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const state = await withStaffOperation(
      getPool(),
      session,
      "finance.payments.collect",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.payments.collect");
        return retireCanonicalCollectionAttemptInTx(
          client,
          {
            idempotencyKey: fields.idempotencyKey,
            patientId: fields.patientId,
            operation: fields.operation,
            requestBody: fields.requestBody,
            originalActor: fields.originalActor,
          },
          { username: identity.username, role: identity.role },
        );
      },
    );
    return NextResponse.json({ state }, { headers: NO_STORE });
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    if (error instanceof CollectionAttemptError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }
    return handleSlice37aError(error, "تعذّر التحقق من المحاولة الآن؛ بقيت محفوظة. أعد المحاولة.");
  }
}

/* ============================================================================
 * 3. SERVICE-MATERIALS (/api/service-materials)
 * ============================================================================ */

export async function serviceMaterialsListCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const serviceIdRaw = Number(new URL(request.url).searchParams.get("serviceId"));
  const serviceId = Number.isInteger(serviceIdRaw) && serviceIdRaw > 0 ? serviceIdRaw : null;
  try {
    const rows = await runCanonicalReadSnapshot(
      session,
      "finance.cost-prices.view",
      async (query) => {
        const { rows: found } = await query.query<{
          id: number;
          service_id: number;
          service_name: string;
          item_id: number;
          item_name: string;
          unit: string;
          qty_per_unit: string;
          note: string | null;
          created_by: string;
        }>(
          `SELECT m.id, m.service_id, s.name AS service_name, m.item_id,
                  i.name AS item_name, i.unit, m.qty_per_unit, m.note, m.created_by
             FROM service_materials m
             JOIN services s ON s.id = m.service_id
             JOIN inventory_items i ON i.id = m.item_id
            ${serviceId ? "WHERE m.service_id = $1" : ""}
            ORDER BY s.name, i.name`,
          serviceId ? [serviceId] : [],
        );
        return found.map((row) => ({
          id: row.id,
          serviceId: row.service_id,
          serviceName: row.service_name,
          itemId: row.item_id,
          itemName: row.item_name,
          unit: row.unit,
          qtyPerUnit: Number(row.qty_per_unit),
          note: row.note,
          createdBy: row.created_by,
        }));
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(rows, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37aError(error, "تعذّر تحميل ربط الخدمات بالمواد.");
  }
}

export async function serviceMaterialsCreateCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const serviceId = Number(source.serviceId);
  const itemId = Number(source.itemId);
  const qty = Number(source.qtyPerUnit);
  const note =
    typeof source.note === "string" && source.note.trim() ? source.note.trim().slice(0, 200) : null;

  if (!Number.isInteger(serviceId) || serviceId <= 0) {
    return NextResponse.json({ message: "اختر الخدمة من الدليل." }, { status: 400 });
  }
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ message: "اختر المادة من المخزون." }, { status: 400 });
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    return NextResponse.json({ message: "الكمية لكل وحدة يجب أن تكون أكبر من صفر." }, { status: 400 });
  }

  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "settings.operational.edit",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "settings.operational.edit");
        const services = await listServicesWith(client, false);
        if (!services.some((service) => service.id === serviceId && service.isActive)) {
          return { status: 400, body: { message: "الخدمة غير موجودة أو موقوفة." } };
        }
        const { rows: itemRows } = await client.query<{ id: number }>(
          `SELECT id FROM inventory_items WHERE id = $1 AND is_active`,
          [itemId],
        );
        if (!itemRows[0]) {
          return { status: 400, body: { message: "المادة غير موجودة أو موقوفة." } };
        }
        const { rows } = await client.query<{ id: number }>(
          `INSERT INTO service_materials (service_id, item_id, qty_per_unit, note, created_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (service_id, item_id) DO UPDATE
             SET qty_per_unit = EXCLUDED.qty_per_unit, note = EXCLUDED.note
           RETURNING id`,
          [serviceId, itemId, qty, note, identity.username],
        );
        await insertAuditRow(client, {
          action: "service_material.set",
          entity: "service_materials",
          entityId: rows[0].id,
          details: {
            الخدمة: serviceId,
            المادة: itemId,
            الكمية_للوحدة: qty,
            ...(note ? { الملاحظة: note } : {}),
          },
          actor: identity.username,
          actorRole: identity.role,
        });
        return { status: 201, body: { id: rows[0].id } };
      },
    );
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error) {
    return handleSlice37aError(error, "تعذّر حفظ الربط.");
  }
}

export async function serviceMaterialsDeleteCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الربط غير صالح." }, { status: 400 });
  }
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "settings.operational.edit",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "settings.operational.edit");
        const { rows: removed } = await client.query<{
          service_id: number;
          item_id: number;
          qty_per_unit: string;
        }>(
          `DELETE FROM service_materials WHERE id = $1 RETURNING service_id, item_id, qty_per_unit::text`,
          [id],
        );
        if (removed.length === 0) {
          return { status: 404, body: { message: "الربط غير موجود." } };
        }
        await insertAuditRow(client, {
          action: "service_material.remove",
          entity: "service_materials",
          entityId: id,
          details: {
            الخدمة: removed[0].service_id,
            المادة: removed[0].item_id,
            الكمية_للوحدة: removed[0].qty_per_unit,
          },
          actor: identity.username,
          actorRole: identity.role,
        });
        return { status: 200, body: { ok: true } };
      },
    );
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error) {
    return handleSlice37aError(error, "تعذّر حذف الربط.");
  }
}

/* ============================================================================
 * 4. SERVICES (/api/services/**)
 * ============================================================================ */

export async function servicesListCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const includeInactive = new URL(request.url).searchParams.get("all") === "1";
  try {
    const list = await runCanonicalReadSnapshot(
      session,
      "finance.service-prices.view",
      async (query, scope) => {
        const services = await listServicesWith(query, includeInactive);
        const settings = await getSettingsInTransaction(query as DbClient);
        const invoiceSettings = scope.granted("finance.invoices.create")
          ? await getSettingsInTransaction(query as DbClient, { requireStoredExchangeRates: true })
          : null;
        const rates = foreignRatesFromSettings(settings);
        const invoiceRates = invoiceSettings ? foreignRatesFromSettings(invoiceSettings) : null;
        return services.map((service) => ({
          ...service,
          priceIn: catalogPricesByCurrency(service, rates),
          ...(invoiceRates
            ? {
                invoiceQuotes: Object.fromEntries(
                  (["YER", "SAR", "USD"] as const).map((currency) => [
                    currency,
                    invoicePriceQuote(service, currency, invoiceRates),
                  ]),
                ),
              }
            : {}),
        }));
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(list, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37aError(error, "تعذّر تحميل قائمة الأسعار.");
  }
}

export async function servicesCreateCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name || name.length > 120) {
    return NextResponse.json({ message: "اكتب اسم الخدمة." }, { status: 400 });
  }
  const base = CLINIC_BASE_CURRENCY;
  const priceMinor = parseAmount(String(source.price ?? ""), base);
  if (priceMinor === null) {
    return NextResponse.json({ message: "اكتب سعرًا صحيحًا." }, { status: 400 });
  }
  const category =
    typeof source.category === "string" && source.category.trim()
      ? source.category.trim().slice(0, 60)
      : null;
  const foreign = readForeignPrices(source);
  if (!foreign.ok) return NextResponse.json({ message: foreign.message }, { status: 400 });

  try {
    const service = await withStaffOperation(
      getPool(),
      session,
      "finance.service-prices.edit",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.service-prices.edit");
        const created = await createServiceInTx(client, {
          name,
          category,
          priceMinor,
          ...foreign.patch,
        });
        await insertAuditRow(client, {
          action: "service.create",
          entity: "service",
          entityId: created.id,
          entityLabel: created.name,
          details: auditSnapshot(created as unknown as Record<string, unknown>, SERVICE_AUDIT_FIELDS),
          actor: identity.username,
          actorRole: identity.role,
        });
        return created;
      },
    );
    return NextResponse.json(service, { status: 201 });
  } catch (error) {
    return handleSlice37aError(error, "تعذّر حفظ الخدمة.");
  }
}

export async function servicePatchCanonicalResponse(
  request: Request,
  idRaw: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const id = parsePositiveId(idRaw);
  if (!id) return NextResponse.json({ message: "رقم الخدمة غير صالح." }, { status: 400 });

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const patch: {
    name?: string;
    category?: string | null;
    priceMinor?: number;
    isActive?: boolean;
    priceSarMinor?: number | null;
    priceUsdMinor?: number | null;
  } = {};

  if (typeof source.name === "string") {
    const name = source.name.trim();
    if (!name || name.length > 120) {
      return NextResponse.json({ message: "اكتب اسم الخدمة." }, { status: 400 });
    }
    patch.name = name;
  }
  if (typeof source.category === "string") {
    patch.category = source.category.trim().slice(0, 60) || null;
  }
  if (source.price !== undefined) {
    const priceMinor = parseAmount(String(source.price), CLINIC_BASE_CURRENCY);
    if (priceMinor === null) {
      return NextResponse.json({ message: "اكتب سعرًا صحيحًا." }, { status: 400 });
    }
    patch.priceMinor = priceMinor;
  }
  if (typeof source.isActive === "boolean") patch.isActive = source.isActive;
  const foreign = readForeignPrices(source);
  if (!foreign.ok) return NextResponse.json({ message: foreign.message }, { status: 400 });
  Object.assign(patch, foreign.patch);

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ message: "لا يوجد ما يُحدَّث." }, { status: 400 });
  }

  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "finance.service-prices.edit",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.service-prices.edit");
        const before = await getServiceWith(client, id);
        const updated = await updateServiceInTx(client, id, patch);
        if (!updated) return { status: 404, body: { message: "الخدمة غير موجودة." } };
        const changes = auditChanges(
          before as unknown as Record<string, unknown>,
          updated as unknown as Record<string, unknown>,
          SERVICE_AUDIT_FIELDS,
        );
        if (Object.keys(changes).length > 0) {
          await insertAuditRow(client, {
            action: "service.update",
            entity: "service",
            entityId: id,
            entityLabel: updated.name,
            details: changes,
            actor: identity.username,
            actorRole: identity.role,
          });
        }
        return { status: 200, body: updated };
      },
    );
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error) {
    return handleSlice37aError(error, "تعذّر حفظ التعديل.");
  }
}

export async function servicesBatchPriceCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const entries = (body as Record<string, unknown>)?.entries;
  if (!Array.isArray(entries)) {
    return NextResponse.json({ message: "لا أسعار في الطلب." }, { status: 400 });
  }
  const base: Currency = CLINIC_BASE_CURRENCY;

  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "finance.service-prices.edit",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.service-prices.edit");
        const services = await listServicesWith(client, true);
        const nameOf = (id: number) => services.find((service) => service.id === id)?.name ?? null;
        const batch = readPriceBatch(entries, (input) => parseAmount(input, base), nameOf);
        if (!batch.ok) return { status: 400, body: { message: batch.message } };
        const result = await priceServiceBatchInTx(client, batch.prices, identity.username);
        if (!result.ok) return { status: 400, body: { message: result.message } };
        const priceOf = new Map(services.map((service) => [service.id, service.priceMinor]));
        await insertAuditRow(client, {
          action: "service.prices.batch",
          entity: "service",
          entityLabel: `${batch.prices.length} خدمة`,
          details: {
            الأسعار: batch.prices.map((price) => ({
              الخدمة: nameOf(price.id),
              رقم: price.id,
              قبل: priceOf.get(price.id) ?? null,
              بعد: price.priceMinor,
            })),
          },
          actor: identity.username,
          actorRole: identity.role,
        });
        return { status: 200, body: { updated: result.updated } };
      },
    );
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error) {
    return handleSlice37aError(error, "تعذّر حفظ الدفعة.");
  }
}

export async function servicesProvisionalPriceCanonicalResponse(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "finance.service-prices.edit",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.service-prices.edit");
        const services = await listServicesWith(client, true);
        const fills = provisionalFills(
          services.map((service) => ({
            id: service.id,
            category: service.category,
            priceConfigured: service.priceConfigured,
            isActive: service.isActive,
          })),
        );
        if (fills.length === 0) {
          return {
            status: 400,
            body: { message: "لا خدمات نشطة بلا سعر تناسب التخميني — كل النشط مسعّر أصلًا." },
          };
        }
        const result = await fillProvisionalServicePricesInTx(client, fills, identity.username);
        if (!result.ok) return { status: 400, body: { message: result.message } };
        const nameOf = new Map(services.map((service) => [service.id, service.name]));
        await insertAuditRow(client, {
          action: "service.prices.provisional",
          entity: "service",
          entityLabel: `${fills.length} خدمة`,
          details: {
            الأسعار: fills.map((fill) => ({
              الخدمة: nameOf.get(fill.id) ?? null,
              رقم: fill.id,
              السعر: fill.priceMinor,
            })),
          },
          actor: identity.username,
          actorRole: identity.role,
        });
        return { status: 200, body: { filled: result.filled } };
      },
    );
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error) {
    return handleSlice37aError(error, "تعذّر ملء الأسعار التخمينية.");
  }
}

/* ============================================================================
 * 5. LEGACY INVENTORY FOUNDATION (/api/inventory/**)
 * ============================================================================ */

export async function inventoryListCanonicalResponse(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const today = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
  try {
    const data = await runCanonicalReadSnapshot(
      session,
      "inventory.references.view",
      async (query) => {
        const items = await listInventoryItemsWith(query);
        const alerts = await inventoryAlertsWith(query, today);
        return { items, alerts };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(data, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37aError(error, "تعذّر تحميل المخزون.");
  }
}

export async function inventoryCreateCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const name = typeof source.name === "string" ? source.name.trim().slice(0, 120) : "";
  if (!name) return NextResponse.json({ message: "اكتب اسم البند." }, { status: 400 });
  const category =
    typeof source.category === "string" && source.category.trim()
      ? source.category.trim().slice(0, 40)
      : "other";
  const unit =
    typeof source.unit === "string" && source.unit.trim() ? source.unit.trim().slice(0, 20) : "وحدة";
  const minLevel = Number(source.minLevel);
  const note =
    typeof source.note === "string" && source.note.trim() ? source.note.trim().slice(0, 300) : null;
  if (!Number.isFinite(minLevel) || minLevel < 0) {
    return NextResponse.json({ message: "حد الطلب رقمٌ لا يقل عن صفر." }, { status: 400 });
  }

  try {
    const item = await withStaffOperation(
      getPool(),
      session,
      "inventory.items.create",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "inventory.items.create");
        return createInventoryItemInTx(
          client,
          { name, category, unit, minLevel, note, createdBy: identity.username },
          identity.role,
        );
      },
    );
    return NextResponse.json(
      { ...item, categoryLabel: itemCategoryLabel(item.category) },
      { status: 201 },
    );
  } catch (error) {
    return handleSlice37aError(error, "تعذّر إنشاء البند. أعد المحاولة.");
  }
}

export async function inventoryDetailCanonicalResponse(
  idRaw: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const id = parsePositiveId(idRaw);
  if (!id) return NextResponse.json({ message: "رقم البند غير صالح." }, { status: 400 });
  try {
    const detail = await runCanonicalReadSnapshot(
      session,
      "inventory.references.view",
      async (query, scope) => {
        const found = await inventoryDetailWithLinks(id, query);
        if (!found) throw new CanonicalSlice37aRefusal(404, "البند غير موجود.");
        const canViewCosts = scope.granted("inventory.costs.view");
        return {
          ...found,
          movements: found.movements.map((movement) =>
            inventoryMovementForRead(movement, canViewCosts),
          ),
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(detail, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37aError(error, "تعذّر تحميل تفاصيل البند.");
  }
}

export async function inventoryUpdateCanonicalResponse(
  request: Request,
  idRaw: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const id = parsePositiveId(idRaw);
  if (!id) return NextResponse.json({ message: "رقم البند غير صالح." }, { status: 400 });

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const patch: Parameters<typeof updateInventoryItemInTx>[2] = {};
  if (typeof source.name === "string" && source.name.trim()) {
    patch.name = source.name.trim().slice(0, 120);
  }
  if (typeof source.category === "string" && source.category.trim()) {
    patch.category = source.category.trim().slice(0, 40);
  }
  if (typeof source.unit === "string" && source.unit.trim()) {
    patch.unit = source.unit.trim().slice(0, 20);
  }
  if (source.minLevel !== undefined) {
    const minLevel = Number(source.minLevel);
    if (!Number.isFinite(minLevel) || minLevel < 0) {
      return NextResponse.json({ message: "حد الطلب رقمٌ لا يقل عن صفر." }, { status: 400 });
    }
    patch.minLevel = minLevel;
  }
  if (source.note !== undefined) {
    patch.note =
      typeof source.note === "string" && source.note.trim()
        ? source.note.trim().slice(0, 300)
        : null;
  }
  if (source.isActive !== undefined) patch.isActive = Boolean(source.isActive);

  try {
    const item = await withStaffOperation(
      getPool(),
      session,
      "inventory.items.create",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "inventory.items.create");
        return updateInventoryItemInTx(client, id, patch, identity.username, identity.role);
      },
    );
    if (!item) return NextResponse.json({ message: "البند غير موجود." }, { status: 404 });
    return NextResponse.json(item);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "historical_unit_change") {
      return NextResponse.json(
        {
          code: "historical_unit_change",
          message:
            "وحدة الصنف مرتبطة بحركات تاريخية. تحتاج تحويلًا معتمدًا يحفظ معنى الكميات السابقة.",
        },
        { status: 409 },
      );
    }
    return handleSlice37aError(error, "تعذّر تعديل البند. أعد المحاولة.");
  }
}

export async function inventoryMovementsCreateCanonicalResponse(
  request: Request,
  idRaw: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const itemId = parsePositiveId(idRaw);
  if (!itemId) return NextResponse.json({ message: "رقم البند غير صالح." }, { status: 400 });

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const requestKey = request.headers.get(INVENTORY_PURCHASE_KEY_HEADER);
  const envelope = purchaseEnvelope(body);
  const keyed = requestKey !== null || (isPurchaseRecord(body) && Object.hasOwn(body, "protocol"));
  if (keyed && (!isPurchaseKey(requestKey) || !envelope)) {
    return NextResponse.json(
      { message: "صيغة طلب الشراء المحمي غير صالحة. حدّث الصفحة دون حذف الطلب المحفوظ." },
      { status: 400 },
    );
  }
  if (keyed && envelope) {
    try {
      canonicalPurchaseRequest(itemId, envelope);
    } catch {
      return NextResponse.json({ message: "طلب الشراء يحتوي قيمة غير صالحة." }, { status: 400 });
    }
  }
  const source = envelope ?? (isPurchaseRecord(body) ? body : {});
  if (!keyed && isUnwrappedFinancialPurchase(source)) {
    return NextResponse.json(
      { message: "يلزم تحديث الصفحة لتسجيل الشراء بطلب محمي من التكرار." },
      { status: 409 },
    );
  }

  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "inventory.reconcile",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "inventory.reconcile");
        const caps = await staffOperationCapabilities(
          client,
          handle,
          "inventory.reconcile",
          [
            "inventory.costs.view",
            "finance.payables.record",
            "inventory.supplier-invoices.record",
          ] as const,
        );
        const canViewCosts = caps.has("inventory.costs.view");
        const canRecordPayables =
          caps.has("finance.payables.record") || caps.has("inventory.supplier-invoices.record");

        if (
          keyed &&
          (request.headers.get("X-Purchase-Actor") !== encodeURIComponent(identity.username) ||
            request.headers.get("X-Purchase-Actor-Id") !== String(identity.userId))
        ) {
          return {
            status: 409,
            body: { message: "تغيّرت جلسة المستخدم. عد إلى الحساب الذي أنشأ الطلب المحفوظ." },
          };
        }

        const refuse = async (message: string, status: 400 | 404 | 409 = 400) => {
          if (!keyed || !requestKey || !envelope) return { status, body: { message } };
          const rejected = await createCanonicalInventoryPurchaseInTx(client, {
            actor: { userId: identity.userId, username: identity.username, canViewCosts },
            requestKey,
            itemId,
            purchase: envelope,
            rejection: { message, httpStatus: status },
          });
          return { status: rejected.httpStatus, body: rejected.body };
        };

        if (!isMovementKind(source.kind)) return refuse("نوع الحركة غير معروف.");
        const kind = source.kind;

        if (
          keyed &&
          source.unitCost !== undefined &&
          source.unitCost !== null &&
          typeof source.unitCost !== "string"
        ) {
          return refuse("ثمن الوحدة رقمٌ غير صالح.");
        }
        if (
          keyed &&
          [source.expiryDate, source.supplierDueDate].some((value) => {
            if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
            const date = new Date(`${value}T00:00:00.000Z`);
            return !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value;
          })
        ) {
          return refuse("تاريخ الشراء غير صالح.");
        }

        if (keyed && typeof source.qty !== "number" && typeof source.qty !== "string") {
          return refuse("اكتب كمية غير صفرية.");
        }
        const qty = Number(source.qty);
        if (!Number.isFinite(qty) || (kind !== "adjust" && qty <= 0) || (kind === "adjust" && qty === 0)) {
          return refuse("اكتب كمية غير صفرية.");
        }
        if (Math.abs(qty) > 1_000_000) return refuse("الكمية خارج المدى المعقول.");

        const reason = keyed
          ? normalizePurchaseReason(source.reason)
          : typeof source.reason === "string" && source.reason.trim()
            ? source.reason.trim().slice(0, 300)
            : null;
        if (keyed && reason?.includes("\u0000")) return refuse("سبب الشراء يحتوي محرفًا غير صالح.");
        if (kind === "adjust" && !reason) {
          return refuse("سبب التسوية إلزامي — اكتب مبرر الجرد (نقص، تلف، تصحيح إحصاء...).");
        }
        const expiryDate =
          typeof source.expiryDate === "string" && DATE_PATTERN.test(source.expiryDate)
            ? source.expiryDate
            : null;

        const baseCurrency: Currency = CLINIC_BASE_CURRENCY;
        const returnPayableRaw = source.returnPayableId;
        let returnPayableId: number | null = null;
        if (returnPayableRaw !== undefined && returnPayableRaw !== null && returnPayableRaw !== "") {
          const parsedPayable =
            typeof returnPayableRaw === "number"
              ? returnPayableRaw
              : typeof returnPayableRaw === "string" && !/[^0-9]/.test(returnPayableRaw)
                ? Number(returnPayableRaw)
                : NaN;
          if (!Number.isInteger(parsedPayable) || parsedPayable <= 0 || parsedPayable > 2_147_483_647) {
            return refuse("رقم فاتورة المورّد غير صالح.");
          }
          returnPayableId = parsedPayable;
        }
        if (returnPayableId !== null && !canRecordPayables) {
          return { status: 403, body: { message: "تسوية مرتجع المورّد للإدارة والاستقبال." } };
        }
        const isSupplierReturn = kind === "out" && source.isReturn === true && returnPayableId !== null;
        if (returnPayableId !== null && !isSupplierReturn) {
          return refuse("ربط التزام المورّد بالمرتجع يتطلّب حركة صرف موسومة كمرتجع (isReturn=true).");
        }
        const unitCost =
          (kind === "in" || isSupplierReturn) &&
          typeof source.unitCost === "string" &&
          source.unitCost.trim() !== ""
            ? parseAmount(source.unitCost, baseCurrency)
            : null;
        if (
          (kind === "in" || isSupplierReturn) &&
          typeof source.unitCost === "string" &&
          source.unitCost.trim() !== "" &&
          unitCost === null
        ) {
          return refuse("ثمن الوحدة رقمٌ غير صالح.");
        }
        const isReturn = (kind === "in" || isSupplierReturn) && source.isReturn === true;
        if (reason?.startsWith(AUTO_MATERIAL_REASON_PREFIX.trim())) {
          return refuse("هذا الوسم محجوز للخصم التلقائي من ربط الخدمات — اكتب سببًا آخر.");
        }

        const visitIdRaw = Number(source.visitId);
        const visitId = Number.isInteger(visitIdRaw) && visitIdRaw > 0 ? visitIdRaw : null;
        const patientIdRaw = Number(source.patientId);
        let patientId = Number.isInteger(patientIdRaw) && patientIdRaw > 0 ? patientIdRaw : null;

        if (visitId !== null) {
          if (kind !== "out") {
            return { status: 400, body: { message: "الزيارة تُربط بصرف المواد وحده." } };
          }
          const visit = await visitPatientOfWith(client, visitId);
          if (!visit) {
            return { status: 404, body: { message: "الزيارة غير موجودة." } };
          }
          if (visit.patientId !== null) {
            if (patientId !== null && patientId !== visit.patientId) {
              return { status: 400, body: { message: "الزيارة لا تخص هذا المريض." } };
            }
            patientId = visit.patientId;
          } else if (patientId !== null) {
            return { status: 400, body: { message: "الزيارة لا تخص هذا المريض." } };
          }
        }

        if (patientId) {
          const pScope = await staffOperationPatientScope(client, handle, "inventory.reconcile");
          if (pScope.kind === "none") {
            return { status: 403, body: { message: "غير مصرّح لك بربط حركة المواد بهذا المريض." } };
          }
          const patientExists = await getPatientWith(client, patientId);
          if (!patientExists) {
            return { status: 403, body: { message: "غير مصرّح لك بربط حركة المواد بهذا المريض." } };
          }
          if (
            pScope.kind === "own" &&
            !(await patientInDoctorScopeWith(client, pScope.clinicianPartyId, patientId))
          ) {
            return { status: 403, body: { message: "غير مصرّح لك بربط حركة المواد بهذا المريض." } };
          }
        }

        const supplierRaw = source.supplierPartyId;
        let supplierPartyId: number | null = null;
        if (supplierRaw !== undefined && supplierRaw !== null && supplierRaw !== "") {
          const parsedSupplier =
            typeof supplierRaw === "number"
              ? supplierRaw
              : typeof supplierRaw === "string" && !/[^0-9]/.test(supplierRaw)
                ? Number(supplierRaw)
                : NaN;
          if (!Number.isInteger(parsedSupplier) || parsedSupplier <= 0 || parsedSupplier > 2_147_483_647) {
            return refuse("رقم المورّد غير صالح.");
          }
          supplierPartyId = parsedSupplier;
        }
        if (supplierPartyId !== null && !canRecordPayables) {
          return { status: 403, body: { message: "تسجيل فاتورة المورّد للإدارة والاستقبال." } };
        }
        const supplierDueDate =
          typeof source.supplierDueDate === "string" && DATE_PATTERN.test(source.supplierDueDate)
            ? source.supplierDueDate
            : null;

        const input = {
          itemId,
          kind,
          qty,
          expiryDate,
          reason,
          visitId,
          patientId,
          createdBy: identity.username,
          unitCostMinor: unitCost,
          isReturn,
          supplierPartyId,
          supplierDueDate,
          returnPayableId,
        };
        if (keyed && requestKey && envelope) {
          const result = await createCanonicalInventoryPurchaseInTx(client, {
            actor: { userId: identity.userId, username: identity.username, canViewCosts },
            requestKey,
            itemId,
            purchase: envelope,
            input,
          });
          return { status: result.httpStatus, body: result.body };
        }

        await client.query("SAVEPOINT canonical_inventory_movement");
        const result = await createInventoryMovementInTransaction(client, input);
        if (!result.ok) {
          await client.query("ROLLBACK TO SAVEPOINT canonical_inventory_movement");
          await client.query("RELEASE SAVEPOINT canonical_inventory_movement");
          return { status: 409, body: { message: result.message } };
        }
        await client.query("RELEASE SAVEPOINT canonical_inventory_movement");
        return {
          status: 201,
          body: {
            ...result,
            movement: inventoryMovementForRead(result.movement, canViewCosts),
          },
        };
      },
    );
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error) {
    return handleSlice37aError(error, "تعذّر تسجيل الحركة. أعد المحاولة.");
  }
}

export async function inventoryPatientCostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });
  }
  try {
    const cost = await runCanonicalReadSnapshot(
      session,
      "read:inventory.patient-cost",
      async (query, scope) => {
        if (!(await patientVisibleInSnapshot(query, scope, patientId))) {
          throw new CanonicalSlice37aRefusal(403, "غير مصرّح لك بالوصول لهذا الملف.");
        }
        return issuedCostForPatientWith(query, patientId);
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(cost, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37aError(error, "تعذّر حساب تكلفة المواد.");
  }
}

export async function inventoryValuationCanonicalResponse(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const valuation = await runCanonicalReadSnapshot(
      session,
      "inventory.costs.view",
      async (query) => readInventoryValuation(query),
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(
      { ...valuation, baseCurrency: CLINIC_BASE_CURRENCY },
      { headers: NO_STORE },
    );
  } catch (error) {
    return handleSlice37aError(error, "تعذّر حساب قيمة المخزون.");
  }
}
