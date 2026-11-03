import "server-only";
import { NextResponse } from "next/server";
import {
  getAccountName,
  LEDGER_CURRENCIES,
  POSTABLE_ACCOUNTS,
  STANDARD_EXPENSE_ACCOUNTS,
  STANDARD_LAB_EXPENSE_ACCOUNTS,
  STANDARD_LAB_PAYABLE_ACCOUNTS,
} from "./accounting";
import { accountLedger, accountingPeriod, LEDGER_HISTORY_START } from "./accounting-reports";
import { auditChanges, auditSnapshot, PARTY_AUDIT_FIELDS } from "./audit-diff";
import { canonicalPatientReadFailure, NO_STORE } from "./canonical-patient-http";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { mergeCommissionBalances } from "./commission-balance";
import {
  COMMISSION_LAB_LINEAGE_REVIEW,
  CommissionLabLineageError,
} from "./commission-lab-lineage";
import { parseCaseOverrideRequest } from "./commission-override-input";
import {
  batchUpdateExpenseCategoriesInTx,
  batchUpdateLabAccountingMappingsInTx,
  caseOverrideTargetsWith,
  CLINIC_TIME_ZONE,
  commissionDetailReportWith,
  commissionReport,
  createCaseOverrideInTx,
  createExpenseCategoryInTx,
  createManualEntryInTx,
  createPartyInTx,
  createPayableInTransaction,
  deleteExpenseCategoryInTx,
  doctorOwnedPatientIdsWith,
  ExpenseCategoryConflictError,
  financeSummaryWith,
  fxReportWith,
  getExpenseAttachmentWith,
  getExpenseWith,
  getLaboratoryWith,
  getOpenShiftWith,
  getPartyWith,
  getPool,
  getSettingsInTransaction,
  getSettingsWith,
  insertAuditRow,
  isPeriodLockedWith,
  journalEntries,
  listAppointmentsByDateWith,
  listCaseOverridesWith,
  listExpenseAttachmentsWith,
  listExpenseCategoriesWith,
  listExpensesBetweenWith,
  listLabAccountingMappingsWith,
  listLabOrdersWith,
  listPartiesWith,
  listShiftExpensesWith,
  listShiftPaymentsWith,
  listShiftsWith,
  loadPartyDueByCurrency,
  loadPartyNativeBalanceSnapshot,
  ManualEntryInvalidError,
  partyBalancesWith,
  partyStatementWith,
  patientDebtReportWith,
  patientInDoctorScopeWith,
  quoteExpenseWith,
  ratesFromSettings,
  recordExpenseAttachmentWith,
  recordExpenseCanonicalInTx,
  settleLabOrdersBatchInTx,
  shiftDrawerBreakdown,
  syncExpenseCategoriesAccountingMappingInTx,
  updateExpenseCategoryOnTx,
  updateLabAccountingMappingWith,
  updatePartyInTx,
  voidExpenseCanonicalInTx,
  type DbClient,
  type ManualEntryLine,
} from "./db";
import { projectExpenseCategories } from "./expense-catalogue-visibility";
import { parseExpenseRequest, refusalStatus } from "./expense-request";
import { isPartyKind } from "./expenses";
import { putFile, readFileByKey, storageStatus, type StoredFile } from "./files";
import { cleanupUncommittedStoredFile, holdStorageKeyShared, plannedStorageKey } from "./file-cleanup";
import { projectFinanceSummary } from "./finance-report-visibility";
import { bodyErrorResponse, readBoundedFormData, readJsonBody } from "./http-body";
import { withHttpIdempotencyInTx } from "./http-idempotency";
import { JOURNAL_REVIEW_RESPONSE, JournalReadIntegrityError } from "./journal-read-integrity";
import { LAB_BALANCE_VIEW, projectLabBalanceOverview } from "./lab-balance-overview";
import {
  detectLabAppointmentMismatches,
  type ReconcileOrderItem,
} from "./lab-reconciliation";
import { contentMatchesMimeType, SIGNATURE_MISMATCH_MESSAGE } from "./magic-bytes";
import { ManualCashEntryConflictError } from "./manual-cash-entry";
import {
  CLINIC_BASE_CURRENCY,
  FinancialCurrencyIntegrityError,
  isCurrency,
  parseAmount,
  type Currency,
} from "./money";
import { sanitizeErrorMessage } from "./redact";
import { addDays, clinicDateString } from "./schedule";
import { JSON_BODY_LIMIT_BYTES, UPLOAD_BODY_LIMIT_BYTES } from "./security-limits";
import { rateFromSettings } from "./settings";
import { staffAdmissionRefusal } from "./staff-capability-editor";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationCapabilities,
  staffOperationIdentity,
  staffOperationPatientScope,
  withStaffOperation,
} from "./staff-operation-runtime";
import { DEFAULT_MAX_BYTES, validateUpload } from "./storage";
import { rateOf, refusalMessage, type SupplierPaymentRefusal } from "./supplier-payments";

/**
 * Canonical Clinic Finance, Accounting, Expenses, Commissions, Reconciliation,
 * Parties & Payables Routes (M2 Slice 37b — 30 HTTP methods across 17 route files).
 */

const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORY_PATTERN = /^[a-z_]{1,40}$/;
const COMMISSION_BALANCE_EPOCH = "1970-01-01";

class CanonicalSlice37bRefusal extends Error {
  readonly code: string;
  readonly explicitCode: boolean;
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 500 | 503,
    message: string,
    code?: string,
  ) {
    super(message);
    this.name = "CanonicalSlice37bRefusal";
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

type TxResponseOutcome = {
  status: number;
  body: unknown;
  replay?: boolean;
};

/**
 * Finding #9 (peer review): delegates to the shared advisory-locked, same-transaction
 * implementation in `lib/http-idempotency.ts` so two concurrent requests with a new
 * key can never both execute (`SELECT ? FOR UPDATE` on an absent row locks nothing).
 */
async function withCanonicalHttpIdempotencyInTx(
  client: DbClient,
  request: Request,
  scope: string,
  actor: string,
  rawPayload: unknown,
  execute: () => Promise<TxResponseOutcome>,
): Promise<TxResponseOutcome> {
  return withHttpIdempotencyInTx(client, request, scope, actor, rawPayload, execute);
}

function toTxJsonResponse(outcome: TxResponseOutcome): NextResponse {
  return NextResponse.json(outcome.body, {
    status: outcome.status,
    headers: outcome.replay
      ? { ...NO_STORE, "X-Idempotent-Replay": "true" }
      : NO_STORE,
  });
}

function handleSlice37bError(error: unknown, fallbackMessage: string): NextResponse {
  const bounded = bodyErrorResponse(error);
  if (bounded) return bounded;
  if (error instanceof CanonicalSlice37bRefusal) {
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

/* ============================================================================
 * 1. ACCOUNTING (/api/accounting)
 * ============================================================================ */

export async function accountingGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = DATE_PATTERN.test(params.get("from") ?? "") ? params.get("from")! : monthStart;
  const to = DATE_PATTERN.test(params.get("to") ?? "") ? params.get("to")! : today;
  const [start, end] = from <= to ? [from, to] : [to, from];
  const account = params.get("account");
  const accountCurrency = params.get("currency");

  try {
    const result = await runCanonicalReadSnapshot(
      session,
      "reports.financial.view",
      async (query) => {
        try {
          const entries = await journalEntries(LEDGER_HISTORY_START, end, query);
          const report = accountingPeriod(entries, start, end);
          const base = CLINIC_BASE_CURRENCY;

          if (account) {
            const currency: Currency = isCurrency(accountCurrency) ? accountCurrency : base;
            return {
              kind: "ok" as const,
              body: {
                from: start,
                to: end,
                account,
                currency,
                ...accountLedger(report, account, currency),
                baseCurrency: base,
              },
            };
          }

          return {
            kind: "ok" as const,
            body: {
              from: start,
              to: end,
              accounts: POSTABLE_ACCOUNTS,
              currencies: LEDGER_CURRENCIES,
              balances: report.balances,
              cumulativeBalances: report.cumulativeBalances,
              accountSummaries: report.accountSummaries,
              statements: report.statements,
              entryCount: report.entryCount,
              baseCurrency: base,
            },
          };
        } catch (error) {
          if (error instanceof JournalReadIntegrityError) {
            return { kind: "domain_error" as const, status: 409, body: JOURNAL_REVIEW_RESPONSE };
          }
          if (error instanceof FinancialCurrencyIntegrityError) {
            return {
              kind: "domain_error" as const,
              status: 409,
              body: {
                message: "في المستندات دفعةٌ لا تُحلّ عملة تسويتها — راجع سجل المدفوعات قبل قراءة الدفاتر.",
              },
            };
          }
          throw error;
        }
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );

    if (result.kind === "domain_error") {
      return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
    }
    return NextResponse.json(result.body, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37bError(error, "تعذّر تحميل الدفاتر.");
  }
}

export async function accountingPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "finance.journal.post",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.journal.post");

        let body: unknown;
        try {
          body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { status: 400, body: { message: "طلب غير صالح." } };
        }
        const source = (body ?? {}) as Record<string, unknown>;

        const date = typeof source.date === "string" && DATE_PATTERN.test(source.date) ? source.date : "";
        if (!date) return { status: 400, body: { message: "تاريخ غير صالح." } };

        if (await isPeriodLockedWith(client, date)) {
          return {
            status: 409,
            body: { message: "الفترة مقفلة. غيّر تاريخ القفل من الإعدادات إن كان القيد لازمًا." },
          };
        }

        const description = typeof source.description === "string" ? source.description.trim() : "";
        if (!description || description.length > 200) {
          return { status: 400, body: { message: "اكتب بيان القيد." } };
        }

        const rawLines = Array.isArray(source.lines) ? source.lines : [];
        if (rawLines.length < 2 || rawLines.length > 20) {
          return { status: 400, body: { message: "القيد يحتاج طرفين على الأقل." } };
        }

        const postable = new Set(POSTABLE_ACCOUNTS.map((account) => account.code));
        const lines: ManualEntryLine[] = [];
        for (const raw of rawLines as Record<string, unknown>[]) {
          const accountCode = typeof raw.accountCode === "string" ? raw.accountCode : "";
          if (!postable.has(accountCode)) {
            return { status: 400, body: { message: "اختر حسابًا تفصيليًا لكل طرف." } };
          }
          if (!isCurrency(raw.currency)) {
            return { status: 400, body: { message: "حدّد عملة كل سطر في القيد." } };
          }
          const currency = raw.currency;
          const amountMinor = parseAmount(String(raw.amount ?? ""), currency);
          if (amountMinor === null || amountMinor <= 0) {
            return { status: 400, body: { message: "اكتب مبلغًا أكبر من صفر لكل طرف." } };
          }
          const side = raw.side === "credit" ? "credit" : "debit";
          lines.push({ accountCode, currency, amountMinor, side });
        }

        return withCanonicalHttpIdempotencyInTx(
          client,
          request,
          "accounting.manual_entry",
          identity.username,
          source,
          async () => {
            try {
              const id = await createManualEntryInTx(client, {
                date,
                description,
                lines,
                createdBy: identity.username,
              });
              await insertAuditRow(client, {
                action: "journal.manual",
                entity: "journal",
                entityId: id,
                entityLabel: description,
                details: {
                  التاريخ: date,
                  البيان: description,
                  الأسطر: lines
                    .map(
                      (line) =>
                        `${line.side === "debit" ? "مدين" : "دائن"} ${line.accountCode} ${line.amountMinor} ${line.currency}`,
                    )
                    .join(" | "),
                },
                actor: identity.username,
                actorRole: identity.role,
              });
              return { status: 201, body: { id } };
            } catch (error) {
              if (error instanceof ManualCashEntryConflictError) {
                return { status: 409, body: { message: error.message, code: error.code } };
              }
              if (error instanceof ManualEntryInvalidError) {
                return { status: 400, body: { message: error.message } };
              }
              throw error;
            }
          },
        );
      },
    );
    return toTxJsonResponse(outcome);
  } catch (error) {
    return handleSlice37bError(error, "تعذّر حفظ القيد.");
  }
}

/* ============================================================================
 * 2. EXPENSE ATTACHMENTS & EXPENSES (/api/expense-attachments/[id], /api/expenses/**)
 * ============================================================================ */

export async function expenseAttachmentReadCanonicalResponse(
  request: Request,
  rawId: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const found = await runCanonicalReadSnapshot(
      session,
      "finance.expenses.view",
      async (query) => {
        const id = Number(rawId);
        if (!Number.isInteger(id) || id <= 0) {
          throw new CanonicalSlice37bRefusal(400, "رقم المرفق غير صالح.");
        }
        const row = await getExpenseAttachmentWith(query, id);
        if (!row) throw new CanonicalSlice37bRefusal(404, "المرفق غير موجود.");
        return row;
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );

    const bytes = await readFileByKey(found.storageKey);
    if (!bytes) {
      return NextResponse.json(
        { message: "وصف المرفق موجود وملفّه مفقود من التخزين. راجع القرص الملحق." },
        { status: 410, headers: NO_STORE },
      );
    }
    const download = new URL(request.url).searchParams.get("download") === "1";
    const name = encodeURIComponent(found.attachment.title);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": found.attachment.mimeType,
        "Content-Length": String(bytes.length),
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${name}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return handleSlice37bError(error, "تعذّر فتح المرفق.");
  }
}

export async function expensesGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const from = DATE_PATTERN.test(params.get("from") ?? "") ? params.get("from")! : today;
  const to = DATE_PATTERN.test(params.get("to") ?? "") ? params.get("to")! : today;
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "finance.expenses.view",
      async (query) => ({
        from,
        to,
        expenses: await listExpensesBetweenWith(query, from, to),
      }),
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37bError(error, "تعذّر تحميل المصروفات.");
  }
}

export async function expensesPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "finance.expenses.create",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.expenses.create");
        const caps = await staffOperationCapabilities(
          client,
          handle,
          "finance.expenses.create",
          ["finance.fx.manage"] as const,
        );

        let body: unknown;
        try {
          body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { status: 400, body: { message: "طلب غير صالح." } };
        }
        const source = (body ?? {}) as Record<string, unknown>;
        const base = CLINIC_BASE_CURRENCY;
        const settingsRates = ratesFromSettings(await getSettingsInTransaction(client));
        const parsed = parseExpenseRequest(source, settingsRates, caps.has("finance.fx.manage"));
        if (!parsed.ok) {
          return { status: parsed.status, body: { message: parsed.message } };
        }
        const request_ = parsed.value;

        return withCanonicalHttpIdempotencyInTx(
          client,
          request,
          "expenses.create",
          identity.username,
          source,
          async () => {
            const { expense, reason, quote } = await recordExpenseCanonicalInTx(
              client,
              {
                category: request_.category,
                partyId: request_.partyId,
                payeeText: request_.payeeText,
                amountMinor: request_.amountMinor,
                currency: request_.currency,
                baseCurrency: base,
                exchangeRate: request_.exchangeRate,
                payableId: request_.payableId,
                note: request_.note,
                createdBy: identity.username,
                actorRole: identity.role,
                rates: settingsRates,
                payableExchangeRate: request_.payableExchangeRate,
                rateOverrideReason: request_.rateOverrideReason,
                prepaymentReason: request_.prepaymentReason,
                expectedQuote: request_.expectedQuote,
              },
              settingsRates,
            );
            if (reason) {
              return {
                status: refusalStatus(reason),
                body: { message: refusalMessage(reason, quote), code: reason, quote },
              };
            }
            return { status: 201, body: expense };
          },
        );
      },
    );
    return toTxJsonResponse(outcome);
  } catch (error) {
    return handleSlice37bError(error, "تعذّر تسجيل الصرف. أعد المحاولة.");
  }
}

export async function expensesDeleteCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "finance.expenses.void",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.expenses.void");

        const params = new URL(request.url).searchParams;
        let id = Number(params.get("id"));
        let reason: string | null = null;
        if (!Number.isInteger(id) || id <= 0) {
          try {
            const body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES);
            const bodyId = Number(body?.id);
            if (Number.isInteger(bodyId) && bodyId > 0) id = bodyId;
            if (typeof body?.reason === "string" && body.reason.trim()) {
              reason = body.reason.trim().slice(0, 300);
            }
          } catch (error) {
            const bounded = bodyErrorResponse(error);
            if (bounded) throw error;
          }
        } else {
          try {
            const body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES);
            if (typeof body?.reason === "string" && body.reason.trim()) {
              reason = body.reason.trim().slice(0, 300);
            }
          } catch (error) {
            const bounded = bodyErrorResponse(error);
            if (bounded) throw error;
          }
        }
        if (!Number.isInteger(id) || id <= 0) {
          return { status: 400, body: { message: "رقم السند غير صالح." } };
        }

        const result = await voidExpenseCanonicalInTx(client, id, {
          actor: identity.username,
          actorRole: identity.role,
          reason,
        });
        if (!result.ok) {
          if (result.reason === "missing_reason") {
            return {
              status: 400,
              body: { message: "اكتب سبب الإبطال — تصحيح مالي بلا سبب مُوثَّق غير مقبول." },
            };
          }
          if (result.reason === "already_voided") {
            return {
              status: 409,
              body: { message: "السند مُبطَل أصلًا — لا يُبطَل قيد الإبطال نفسه." },
            };
          }
          if (result.reason === "closed_shift") {
            return {
              status: 409,
              body: {
                message:
                  "وردية السند مقفلة ومجرودة — لا يُبطَل منها شيء بعد الاعتماد؛ القيد التصحيحي يُسجَّل في وردية مفتوحة.",
              },
            };
          }
          if (result.reason === "no_shift") {
            return {
              status: 409,
              body: {
                message: "لا توجد وردية مفتوحة. إبطال سداد المورد قيدٌ في وردية اليوم — افتح الوردية أولًا.",
              },
            };
          }
          return { status: 404, body: { message: "السند غير موجود." } };
        }
        return {
          status: 200,
          body: {
            message: `أُبطل السند بقيد معاكس (${result.voidedVoucherNumber ?? ""}) وسُجِّل الإبطال في التدقيق — الأصل باقٍ بلا تعديل.`,
          },
        };
      },
    );
    return toTxJsonResponse(outcome);
  } catch (error) {
    return handleSlice37bError(error, "تعذّر حذف السند. أعد المحاولة.");
  }
}

export async function expenseAttachmentsListCanonicalResponse(
  rawId: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "finance.expenses.view",
      async (query) => {
        const expenseId = Number(rawId);
        if (!Number.isInteger(expenseId) || expenseId <= 0) {
          throw new CanonicalSlice37bRefusal(400, "رقم السند غير صالح.");
        }
        return { attachments: await listExpenseAttachmentsWith(query, expenseId) };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37bError(error, "تعذّر تحميل المرفقات.");
  }
}

export async function expenseAttachmentsCreateCanonicalResponse(
  request: Request,
  rawId: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let uploadedStored: StoredFile | null = null;
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "finance.expenses.create",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.expenses.create");

        const expenseId = Number(rawId);
        if (!Number.isInteger(expenseId) || expenseId <= 0) {
          return { status: 400, body: { message: "رقم السند غير صالح." } };
        }
        const expense = await getExpenseWith(client, expenseId);
        if (!expense) {
          return { status: 404, body: { message: "سند الصرف غير موجود." } };
        }

        const storage = await storageStatus();
        if (!storage.ready) {
          return { status: 503, body: { message: storage.message } };
        }

        let form: FormData;
        try {
          form = await readBoundedFormData(request, UPLOAD_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { status: 400, body: { message: "طلب غير صالح." } };
        }
        const file = form.get("file");
        if (!(file instanceof File)) {
          return { status: 400, body: { message: "اختر ملفًّا." } };
        }

        const settings = await getSettingsInTransaction(client);
        const configured = Number(settings["documents.max_megabytes"]);
        const maxBytes =
          Number.isFinite(configured) && configured > 0
            ? Math.round(configured * 1024 * 1024)
            : DEFAULT_MAX_BYTES;
        const check = validateUpload({ mimeType: file.type, sizeBytes: file.size, maxBytes });
        if (!check.ok) {
          return { status: 400, body: { message: check.message } };
        }

        const rawTitle = typeof form.get("title") === "string" ? String(form.get("title")).trim() : "";
        const title = (rawTitle || file.name || "إيصال").slice(0, 120);

        const bytes = Buffer.from(await file.arrayBuffer());
        if (!contentMatchesMimeType(bytes, file.type)) {
          return { status: 400, body: { message: SIGNATURE_MISMATCH_MESSAGE } };
        }
        await holdStorageKeyShared(client, plannedStorageKey(bytes, check.extension));
        const stored = await putFile(bytes, check.extension);
        uploadedStored = stored;
        const attachment = await recordExpenseAttachmentWith(client, {
          expenseId,
          title,
          mimeType: file.type,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          storageKey: stored.key,
          uploadedBy: identity.username,
        });
        if (!attachment) {
          return { status: 404, body: { message: "سند الصرف غير موجود." } };
        }
        await insertAuditRow(client, {
          action: "expense.attachment",
          entity: "expense",
          entityId: expenseId,
          entityLabel: expense.voucherNumber,
          details: { السند: expense.voucherNumber, الملف: title, الحجم: attachment.sizeBytes },
          actor: identity.username,
          actorRole: identity.role,
        });
        return { status: 201, body: attachment };
      },
    );
    if (outcome.status >= 400) {
      // The transaction committed without a referencing row (e.g. 404): reconcile.
      await cleanupUncommittedStoredFile(uploadedStored);
    }
    return toTxJsonResponse(outcome);
  } catch (error) {
    await cleanupUncommittedStoredFile(uploadedStored);
    return handleSlice37bError(error, "تعذّر حفظ الملف. أعد المحاولة.");
  }
}

/** Read-only quote preview (`AUDIT_EXEMPT` — zero database writes and zero audit calls). */
export async function expensesQuoteCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const result = await runCanonicalReadSnapshot(
      session,
      "finance.expenses.create",
      async (query, scope) => {
        let body: unknown;
        try {
          body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { kind: "validation" as const, status: 400, body: { message: "طلب غير صالح." } };
        }
        const settingsRates = ratesFromSettings(await getSettingsWith(query));
        const parsed = parseExpenseRequest(
          (body ?? {}) as Record<string, unknown>,
          settingsRates,
          scope.granted("finance.fx.manage"),
        );
        if (!parsed.ok) {
          return { kind: "validation" as const, status: parsed.status, body: { message: parsed.message } };
        }
        const value = parsed.value;
        const { reason, quote } = await quoteExpenseWith(
          query,
          {
            category: value.category,
            partyId: value.partyId,
            payeeText: value.payeeText,
            amountMinor: value.amountMinor,
            currency: value.currency,
            baseCurrency: CLINIC_BASE_CURRENCY,
            exchangeRate: value.exchangeRate,
            payableId: value.payableId,
            note: value.note,
            createdBy: scope.username,
            rates: settingsRates,
            payableExchangeRate: value.payableExchangeRate,
            rateOverrideReason: value.rateOverrideReason,
            prepaymentReason: value.prepaymentReason,
            quoteOnly: true,
          },
          settingsRates,
        );
        return {
          kind: "ok" as const,
          body: {
            ok: reason === null,
            code: reason,
            message: reason ? refusalMessage(reason, quote) : null,
            status: reason ? refusalStatus(reason) : 200,
            quote,
            settingsRates,
          },
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    if (result.kind === "validation") {
      return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
    }
    return NextResponse.json(result.body, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37bError(error, "تعذّر حساب المعاينة. أعد المحاولة.");
  }
}

/* ============================================================================
 * 3. COMMISSIONS & OVERRIDES (/api/finance/commission-overrides, /api/finance/commissions)
 * ============================================================================ */

export async function commissionOverridesGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const raw = new URL(request.url).searchParams.get("patientId");
  const patientId = raw && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "finance.commissions.manage-rates",
      async (query, scope) => {
        if (scope.patientScope.kind === "none") {
          throw new CanonicalSlice37bRefusal(403, "نطاق وصولك للمرضى مغلق.");
        }
        if (
          scope.patientScope.kind === "own" &&
          patientId !== null &&
          !(await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, patientId))
        ) {
          throw new CanonicalSlice37bRefusal(403, "غير مصرح بالوصول إلى المريض.");
        }
        const rawOverrides = await listCaseOverridesWith(query, { patientId });
        let overrides = rawOverrides;
        if (scope.patientScope.kind === "own" && patientId === null) {
          const owned = await doctorOwnedPatientIdsWith(
            query,
            scope.patientScope.clinicianPartyId,
            rawOverrides.flatMap((o) => (o.patientId !== null ? [o.patientId] : [])),
          );
          overrides = rawOverrides.filter((o) => o.patientId !== null && owned.has(o.patientId));
        }
        const targets = patientId ? await caseOverrideTargetsWith(query, patientId) : null;
        return { overrides, targets };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37bError(error, "تعذّر تحميل النسب الخاصة.");
  }
}

export async function commissionOverridesPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "finance.commissions.manage-rates",
      async (client, handle) => {
        const patientScope = await staffOperationPatientScope(
          client,
          handle,
          "finance.commissions.manage-rates",
        );
        if (patientScope.kind === "none") {
          return { status: 403, body: { message: "نطاق وصولك للمرضى مغلق." } };
        }
        const identity = await staffOperationIdentity(client, handle, "finance.commissions.manage-rates");
        let body: unknown = null;
        try {
          body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
        }
        const parsed = parseCaseOverrideRequest(body);
        if (!parsed.ok) {
          return { status: 400, body: { message: parsed.message } };
        }
        if (patientScope.kind === "own") {
          const { rows: targetRows } =
            parsed.value.caseId !== null
              ? await client.query<{ patient_id: number }>(
                  `SELECT patient_id FROM clinical_cases WHERE id = $1`,
                  [parsed.value.caseId],
                )
              : await client.query<{ patient_id: number }>(
                  `SELECT patient_id FROM treatment_plans WHERE id = $1`,
                  [parsed.value.planId],
                );
          if (
            targetRows[0] &&
            !(await patientInDoctorScopeWith(
              client,
              patientScope.clinicianPartyId,
              targetRows[0].patient_id,
            ))
          ) {
            return { status: 403, body: { message: "غير مصرح بالوصول إلى المريض." } };
          }
        }
        const result = await createCaseOverrideInTx(client, {
          ...parsed.value,
          actor: identity.username,
          actorRole: identity.role,
        });
        if (!result.ok) {
          return { status: result.status, body: { message: result.message } };
        }
        return { status: 201, body: { override: result.override } };
      },
    );
    return toTxJsonResponse(outcome);
  } catch (error) {
    return handleSlice37bError(error, "تعذّر حفظ النسبة الخاصة.");
  }
}

export async function commissionsGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = DATE_PATTERN.test(params.get("from") ?? "") ? params.get("from")! : monthStart;
  const to = DATE_PATTERN.test(params.get("to") ?? "") ? params.get("to")! : today;
  const [start, end] = from <= to ? [from, to] : [to, from];
  const base = CLINIC_BASE_CURRENCY;

  try {
    const result = await runCanonicalReadSnapshot(
      session,
      "read:finance.commissions",
      async (query, scope) => {
        const isPersonalOnly = !scope.granted("finance.commissions.view-all");
        const ownPartyId = isPersonalOnly ? scope.clinicianPartyId : null;
        try {
          if (params.get("detail") === "1") {
            if (isPersonalOnly && ownPartyId === null) {
              return {
                kind: "ok" as const,
                body: {
                  from: start,
                  to: end,
                  rows: [],
                  lines: [],
                  unallocatedMaterials: [],
                  serviceRateFindings: [],
                  baseCurrency: base,
                  isPersonalOnly,
                },
              };
            }
            const requestedDoctor = Number(params.get("doctorId"));
            const doctorId = isPersonalOnly
              ? ownPartyId
              : Number.isInteger(requestedDoctor) && requestedDoctor > 0
                ? requestedDoctor
                : null;
            const currencyParam = params.get("currency");
            const categoryParam = params.get("specialty");
            const report = await commissionDetailReportWith(query, start, end, {
              doctorId,
              currency: currencyParam && isCurrency(currencyParam) ? currencyParam : null,
              category: categoryParam && CATEGORY_PATTERN.test(categoryParam) ? categoryParam : null,
            });
            return {
              kind: "ok" as const,
              body: {
                ...report,
                unallocatedMaterials: isPersonalOnly ? [] : report.unallocatedMaterials,
                baseCurrency: base,
                isPersonalOnly,
              },
            };
          }

          if (isPersonalOnly && ownPartyId === null) {
            return {
              kind: "ok" as const,
              body: {
                from: start,
                to: end,
                rows: [],
                baseCurrency: isCurrency(base) ? base : "YER",
                isPersonalOnly,
              },
            };
          }

          const periodRows = await commissionReport(start, end, undefined, query);
          const cumulativeRows =
            start === COMMISSION_BALANCE_EPOCH
              ? periodRows
              : await commissionReport(COMMISSION_BALANCE_EPOCH, end, undefined, query);
          const allRows = mergeCommissionBalances(periodRows, cumulativeRows);
          const rows = isPersonalOnly
            ? allRows.filter((r) => ownPartyId !== null && r.doctorId === ownPartyId)
            : allRows;
          return {
            kind: "ok" as const,
            body: {
              from: start,
              to: end,
              rows,
              baseCurrency: isCurrency(base) ? base : "YER",
              isPersonalOnly,
            },
          };
        } catch (error) {
          if (error instanceof CommissionLabLineageError) {
            return {
              kind: "domain_error" as const,
              status: error.status,
              body: COMMISSION_LAB_LINEAGE_REVIEW,
            };
          }
          throw error;
        }
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    if (result.kind === "domain_error") {
      return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
    }
    return NextResponse.json(result.body, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37bError(error, "تعذّر تحميل العمولات.");
  }
}

/* ============================================================================
 * 4. DEBTS & EXPENSE CATEGORIES (/api/finance/debts, /api/finance/expense-categories)
 * ============================================================================ */

export async function debtsGetCanonicalResponse(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "finance.patient-ledger.view",
      async (query, scope) => {
        if (scope.patientScope.kind === "none") {
          throw new CanonicalSlice37bRefusal(403, "نطاق وصولك للمرضى مغلق.");
        }
        const allRows = await patientDebtReportWith(query);
        let rows = allRows;
        if (scope.patientScope.kind === "own") {
          const owned = await doctorOwnedPatientIdsWith(
            query,
            scope.patientScope.clinicianPartyId,
            allRows.map((r) => r.patientId),
          );
          rows = allRows.filter((r) => owned.has(r.patientId));
        }
        return {
          rows,
          baseCurrency: CLINIC_BASE_CURRENCY,
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37bError(error, "تعذّر تحميل المديونية.");
  }
}

export async function expenseCategoriesGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const month = searchParams.get("month") || undefined;
  const includeInactive = searchParams.get("includeInactive") === "true";
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "read:finance.expense-categories",
      async (query, scope) => {
        const { categories, summary } = await listExpenseCategoriesWith(query, {
          month,
          includeInactive,
        });
        const access = scope.granted("finance.expenses.view") ? "full" : "catalogue";
        return projectExpenseCategories(
          {
            categories,
            summary,
            standardExpenseAccounts: STANDARD_EXPENSE_ACCOUNTS,
            baseCurrency: CLINIC_BASE_CURRENCY,
          },
          access,
        );
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37bError(error, "تعذّر تحميل بنود المصروفات التشغيلية والميزانيات.");
  }
}

export async function expenseCategoriesPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "settings.finance.edit",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "settings.finance.edit");
        const body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES);

        try {
          if (body.action === "sync_accounting" || body.action === "ensure_all_linked") {
            const syncResult = await syncExpenseCategoriesAccountingMappingInTx(client);
            await insertAuditRow(client, {
              actor: identity.username,
              actorRole: identity.role,
              action: "settings.update",
              entity: "expense_categories",
              entityLabel: "ضبط الربط المحاسبي التلقائي لبنود المصروفات",
              details: {
                action: "sync_accounting",
                fixedCount: syncResult.fixedCount,
                totalSynced: syncResult.totalSynced,
              },
            });
            return {
              status: 200,
              body: {
                ok: true,
                message: `تم ضبط وتأكيد الربط المحاسبي لـ ${syncResult.totalSynced} بنداً مع تفعيل الترحيل التلقائي.`,
                fixedCount: syncResult.fixedCount,
                totalSynced: syncResult.totalSynced,
                categories: syncResult.categories,
              },
            };
          }

          const name = typeof body.name === "string" ? body.name.trim() : "";
          const accountCode = typeof body.accountCode === "string" ? body.accountCode.trim() : "";
          if (!name) {
            return { status: 400, body: { message: "اسم بند المصروف مطلوب." } };
          }
          if (!accountCode) {
            return { status: 400, body: { message: "كود الحساب بدليل الحسابات مطلوب." } };
          }

          const created = await createExpenseCategoryInTx(client, {
            key: typeof body.key === "string" ? body.key : undefined,
            name,
            categoryGroup: typeof body.categoryGroup === "string" ? body.categoryGroup : undefined,
            accountCode,
            monthlyBudgetMinor: Number(body.monthlyBudgetMinor) || 0,
            annualBudgetMinor: Number(body.annualBudgetMinor) || 0,
            budgetCurrency: isCurrency(body.budgetCurrency)
              ? body.budgetCurrency
              : CLINIC_BASE_CURRENCY,
            autoPostJournal: body.autoPostJournal !== false,
            description: typeof body.description === "string" ? body.description : undefined,
            displayOrder: Number(body.displayOrder) || 50,
          });

          await insertAuditRow(client, {
            actor: identity.username,
            actorRole: identity.role,
            action: "settings.update",
            entity: "expense_categories",
            entityLabel: created.name,
            details: {
              operation: "create",
              name: created.name,
              accountCode: created.accountCode,
              autoPostJournal: created.autoPostJournal,
              monthlyBudgetMinor: created.monthlyBudgetMinor,
            },
          });
          return { status: 200, body: { ok: true, category: created } };
        } catch (error) {
          if (error instanceof ExpenseCategoryConflictError) {
            return { status: 409, body: { message: error.message } };
          }
          throw error;
        }
      },
    );
    return toTxJsonResponse(outcome);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    const refusal = staffAdmissionRefusal(error);
    if (refusal) {
      return NextResponse.json(
        { code: refusal.code, message: refusal.message },
        { status: refusal.status, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { message: sanitizeErrorMessage(error, "تعذّر إنشاء بند المصروف التشغيلي.") },
      { status: 500, headers: NO_STORE },
    );
  }
}

export async function expenseCategoriesPatchCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "settings.finance.edit",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "settings.finance.edit");
        const body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES);

        try {
          if (Array.isArray(body.updates)) {
            const result = await batchUpdateExpenseCategoriesInTx(
              client,
              body.updates as Array<{
                id: number;
                accountCode?: string;
                monthlyBudgetMinor?: number;
                annualBudgetMinor?: number;
                autoPostJournal?: boolean;
                isActive?: boolean;
              }>,
            );
            await insertAuditRow(client, {
              actor: identity.username,
              actorRole: identity.role,
              action: "settings.update",
              entity: "expense_categories",
              entityLabel: `تحديث ${result.updatedCount} بنداً`,
              details: { batchCount: result.updatedCount },
            });
            return { status: 200, body: { ok: true, updatedCount: result.updatedCount } };
          }

          const id = Number(body.id);
          if (!id || id <= 0) {
            return { status: 400, body: { message: "معرف البند غير صحيح." } };
          }

          const success = await updateExpenseCategoryOnTx(client, id, {
            name: typeof body.name === "string" ? body.name : undefined,
            categoryGroup: typeof body.categoryGroup === "string" ? body.categoryGroup : undefined,
            accountCode: typeof body.accountCode === "string" ? body.accountCode : undefined,
            monthlyBudgetMinor:
              body.monthlyBudgetMinor !== undefined ? Number(body.monthlyBudgetMinor) : undefined,
            annualBudgetMinor:
              body.annualBudgetMinor !== undefined ? Number(body.annualBudgetMinor) : undefined,
            budgetCurrency: isCurrency(body.budgetCurrency) ? body.budgetCurrency : undefined,
            isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
            autoPostJournal:
              typeof body.autoPostJournal === "boolean" ? body.autoPostJournal : undefined,
            description:
              typeof body.description === "string" || body.description === null
                ? body.description
                : undefined,
            displayOrder: body.displayOrder !== undefined ? Number(body.displayOrder) : undefined,
          });
          if (!success) {
            return { status: 404, body: { message: "لم يتم العثور على البند المطلوب تحديثه." } };
          }

          await insertAuditRow(client, {
            actor: identity.username,
            actorRole: identity.role,
            action: "settings.update",
            entity: "expense_categories",
            entityId: id,
            entityLabel: typeof body.name === "string" && body.name ? body.name : `بند #${id}`,
            details: {
              id,
              name: body.name,
              accountCode: body.accountCode,
              autoPostJournal: body.autoPostJournal,
              monthlyBudgetMinor: body.monthlyBudgetMinor,
            },
          });
          return { status: 200, body: { ok: true } };
        } catch (error) {
          if (error instanceof ExpenseCategoryConflictError) {
            return { status: 409, body: { message: error.message } };
          }
          throw error;
        }
      },
    );
    return toTxJsonResponse(outcome);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    const refusal = staffAdmissionRefusal(error);
    if (refusal) {
      return NextResponse.json(
        { code: refusal.code, message: refusal.message },
        { status: refusal.status, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { message: sanitizeErrorMessage(error, "تعذّر حفظ تعديلات بند المصروف.") },
      { status: 500, headers: NO_STORE },
    );
  }
}

export async function expenseCategoriesDeleteCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "settings.finance.edit",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "settings.finance.edit");
        const { searchParams } = new URL(request.url);
        const id = Number(searchParams.get("id"));
        if (!id || id <= 0) {
          return { status: 400, body: { message: "معرف البند غير صحيح." } };
        }

        try {
          const result = await deleteExpenseCategoryInTx(client, id);
          if (!result.success) {
            return { status: 404, body: { message: "تعذّر حذف أو تعطيل البند." } };
          }
          await insertAuditRow(client, {
            actor: identity.username,
            actorRole: identity.role,
            action: "settings.update",
            entity: "expense_categories",
            entityId: id,
            entityLabel: `بند #${id}`,
            details: { deactivated: result.deactivated },
          });
          return { status: 200, body: { ok: true, deactivated: result.deactivated } };
        } catch (error) {
          if (error instanceof ExpenseCategoryConflictError) {
            return { status: 409, body: { message: error.message } };
          }
          throw error;
        }
      },
    );
    return toTxJsonResponse(outcome);
  } catch (error) {
    return handleSlice37bError(error, "تعذّر حذف بند المصروف.");
  }
}

/* ============================================================================
 * 5. FX, LAB ACCOUNTING, LAB RECONCILIATION, RECONCILIATION & REPORT
 * ============================================================================ */

function fxAsOfFrom(request: Request): string {
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const raw = new URL(request.url).searchParams.get("asOf");
  return raw && DATE_PATTERN.test(raw) && raw <= today ? raw : today;
}

export async function fxGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const asOf = fxAsOfFrom(request);
  try {
    const result = await runCanonicalReadSnapshot(
      session,
      "finance.reconciliation.view",
      async (query) => {
        try {
          return { kind: "ok" as const, body: await fxReportWith(query, asOf) };
        } catch (error) {
          if (error instanceof JournalReadIntegrityError) {
            return { kind: "domain_error" as const, status: 409, body: JOURNAL_REVIEW_RESPONSE };
          }
          if (error instanceof FinancialCurrencyIntegrityError) {
            return {
              kind: "domain_error" as const,
              status: 409,
              body: {
                message: "في المستندات دفعةٌ لا تُحلّ عملة تسويتها — راجع سجل المدفوعات قبل قراءة المراكز.",
              },
            };
          }
          throw error;
        }
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    if (result.kind === "domain_error") {
      return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
    }
    return NextResponse.json(result.body, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37bError(error, "تعذّر حساب مراكز العملات.");
  }
}

/** Refusal-only native-ledger endpoint (`AUDIT_EXEMPT` — zero writes and zero audit calls). */
export async function fxPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const result = await runCanonicalReadSnapshot(
      session,
      "finance.fx.manage",
      async (query) => {
        let body: unknown;
        try {
          body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { status: 400, body: { message: "طلب غير صالح." } };
        }
        const source = (body ?? {}) as Record<string, unknown>;
        if (!isCurrency(source.currency)) {
          return { status: 400, body: { message: "اختر العملة." } };
        }
        const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
        const asOf =
          typeof source.asOf === "string" && DATE_PATTERN.test(source.asOf) && source.asOf <= today
            ? source.asOf
            : today;
        if (await isPeriodLockedWith(query, asOf)) {
          return { status: 409, body: { message: "الفترة مقفلة. لا يُرحَّل فيها قيد." } };
        }
        return {
          status: 409,
          body: {
            message:
              "الدفاتر بعملاتها الأصلية — لا يُرحَّل قيد إعادة تقييم. قيمة ما نملكه من كل عملة بسعر اليوم معروضةٌ للعلم في هذه الشاشة.",
            reason: "native_ledger",
          },
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
  } catch (error) {
    return handleSlice37bError(error, "تعذّر معالجة طلب إعادة التقييم.");
  }
}

export async function labAccountingGetCanonicalResponse(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "finance.reconciliation.view",
      async (query) => {
        const mappings = await listLabAccountingMappingsWith(query);
        const summary = {
          totalLabs: mappings.length,
          activeLabs: mappings.filter((m) => m.isActive).length,
          totalOwedMinor: mappings.reduce((sum, m) => sum + m.totalOwedMinor, 0),
          totalPaidMinor: mappings.reduce((sum, m) => sum + m.totalPaidMinor, 0),
          totalDueMinor: mappings.reduce((sum, m) => sum + m.dueMinor, 0),
          activeOrdersTotal: mappings.reduce((sum, m) => sum + m.activeOrdersCount, 0),
          customMappedCount: mappings.filter(
            (m) => m.expenseAccountCode !== "5101" || m.payableAccountCode !== "2101",
          ).length,
        };
        return {
          mappings,
          standardExpenseAccounts: STANDARD_LAB_EXPENSE_ACCOUNTS,
          standardPayableAccounts: STANDARD_LAB_PAYABLE_ACCOUNTS,
          summary,
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37bError(error, "تعذّر تحميل إعدادات الحسابات للمختبرات.");
  }
}

export async function labAccountingPatchCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "finance.reconciliation.manage",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.reconciliation.manage");
        let body: unknown;
        try {
          body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { status: 400, body: { message: "طلب غير صالح." } };
        }
        const source = (body ?? {}) as Record<string, unknown>;

        if (Array.isArray(source.updates)) {
          const updates = source.updates
            .map((u: Record<string, unknown>) => ({
              id: Number(u.id),
              expenseAccountCode:
                typeof u.expenseAccountCode === "string" ? u.expenseAccountCode.trim() : undefined,
              payableAccountCode:
                typeof u.payableAccountCode === "string" ? u.payableAccountCode.trim() : undefined,
              autoPostJournal:
                typeof u.autoPostJournal === "boolean" ? u.autoPostJournal : undefined,
              customAccountName:
                typeof u.customAccountName === "string"
                  ? u.customAccountName.trim()
                  : u.customAccountName === null
                    ? null
                    : undefined,
            }))
            .filter((u) => Number.isInteger(u.id) && u.id > 0);

          if (updates.length === 0) {
            return { status: 400, body: { message: "لا توجد تعديلات صالحة للتطبيق." } };
          }
          const result = await batchUpdateLabAccountingMappingsInTx(client, updates);
          await insertAuditRow(client, {
            action: "settings.update",
            actor: identity.username,
            actorRole: identity.role,
            details: {
              entity: "lab_accounting_mappings",
              count: result.updatedCount,
              message: `تحديث جماعي لربط الحسابات لعدد ${result.updatedCount} مختبر`,
            },
          });
          const refreshed = await listLabAccountingMappingsWith(client);
          return {
            status: 200,
            body: { ok: true, updatedCount: result.updatedCount, mappings: refreshed },
          };
        }

        const id = Number(source.id);
        if (!Number.isInteger(id) || id <= 0) {
          return { status: 400, body: { message: "معرّف المختبر غير صالح." } };
        }
        const expenseCode =
          typeof source.expenseAccountCode === "string"
            ? source.expenseAccountCode.trim()
            : undefined;
        const payableCode =
          typeof source.payableAccountCode === "string"
            ? source.payableAccountCode.trim()
            : undefined;
        const autoPost =
          typeof source.autoPostJournal === "boolean" ? source.autoPostJournal : undefined;
        const customName =
          typeof source.customAccountName === "string"
            ? source.customAccountName.trim()
            : source.customAccountName === null
              ? null
              : undefined;

        const lab = await getLaboratoryWith(client, id);
        if (!lab) {
          return { status: 404, body: { message: "المختبر غير موجود." } };
        }
        const success = await updateLabAccountingMappingWith(client, id, {
          expenseAccountCode: expenseCode,
          payableAccountCode: payableCode,
          autoPostJournal: autoPost,
          customAccountName: customName,
        });
        if (!success) {
          return { status: 500, body: { message: "تعذّر حفظ التعديلات." } };
        }
        await insertAuditRow(client, {
          action: "settings.update",
          actor: identity.username,
          actorRole: identity.role,
          details: {
            entity: "lab_accounting_mapping",
            id,
            labName: lab.name,
            expenseAccount: expenseCode ? `${expenseCode} (${getAccountName(expenseCode)})` : undefined,
            payableAccount: payableCode ? `${payableCode} (${getAccountName(payableCode)})` : undefined,
            autoPostJournal: autoPost,
            message: `تحديث ربط الحسابات للمختبر: ${lab.name} (حساب المصروف: ${expenseCode ?? lab.expenseAccountCode})`,
          },
        });
        const refreshed = await listLabAccountingMappingsWith(client);
        return { status: 200, body: { ok: true, mappings: refreshed } };
      },
    );
    return toTxJsonResponse(outcome);
  } catch (error) {
    return handleSlice37bError(error, "تعذّر حفظ التعديلات.");
  }
}

export async function labReconciliationGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const hasView = searchParams.has("view");
  try {
    const result = await runCanonicalReadSnapshot(
      session,
      "finance.reconciliation.view",
      async (query, scope) => {
        if (hasView) {
          if (!scope.granted("finance.suppliers.view")) {
            return {
              status: 403,
              body: { message: "أرصدة المختبرات متاحة للمدير فقط." },
            };
          }
          if (
            searchParams.getAll("view").length !== 1 ||
            searchParams.get("view") !== LAB_BALANCE_VIEW ||
            [...searchParams.keys()].some((key) => key !== "view")
          ) {
            return {
              status: 400,
              body: { message: "نمط قراءة أرصدة المختبرات غير صالح." },
            };
          }
          const catalog = await listPartiesWith(query, "lab");
          const balances = await loadPartyDueByCurrency(query);
          return {
            status: 200,
            body: projectLabBalanceOverview(catalog, balances, new Date().toISOString()),
          };
        }

        const partyIdParam = searchParams.get("partyId");
        const targetPartyId = partyIdParam ? Number(partyIdParam) : null;
        const now = new Date();
        const todayStr = clinicDateString(now, CLINIC_TIME_ZONE);
        const tomorrowStr = addDays(todayStr, 1);
        const afterTomorrowStr = addDays(todayStr, 2);

        if (scope.patientScope.kind === "none") {
          return {
            status: 403,
            body: { message: "نطاق وصولك للمرضى مغلق." },
          };
        }

        const scopedDoctorPartyId =
          scope.patientScope.kind === "own" ? scope.patientScope.clinicianPartyId : undefined;
        const canReadAppointments = scope.appointmentScope.kind !== "none";
        const apptDoctorId =
          scope.appointmentScope.kind === "own" ? scope.appointmentScope.clinicianPartyId : null;

        const [labParties, allOrders, todayAppts, tomorrowAppts, afterAppts] = await Promise.all([
          listPartiesWith(query, "lab"),
          listLabOrdersWith(query, {
            limit: 300,
            ...(scopedDoctorPartyId !== undefined ? { scopedDoctorPartyId } : {}),
          }),
          canReadAppointments ? listAppointmentsByDateWith(query, todayStr, apptDoctorId) : Promise.resolve([]),
          canReadAppointments ? listAppointmentsByDateWith(query, tomorrowStr, apptDoctorId) : Promise.resolve([]),
          canReadAppointments ? listAppointmentsByDateWith(query, afterTomorrowStr, apptDoctorId) : Promise.resolve([]),
        ]);

        const upcomingAppts = [...todayAppts, ...tomorrowAppts, ...afterAppts];
        const risks = detectLabAppointmentMismatches(upcomingAppts, allOrders, todayStr);

        if (targetPartyId) {
          const party = labParties.find((p) => p.id === targetPartyId);
          if (!party) {
            return { status: 404, body: { message: "المختبر غير موجود." } };
          }
          const partyOrders = allOrders.filter(
            (o) => (o.partyId === targetPartyId || o.labName === party.name) && o.isPosted !== false,
          );
          const reconcileItems: ReconcileOrderItem[] = partyOrders.map((o) => ({
            orderId: o.id,
            patientName: o.patientName,
            patientNumber: o.patientNumber,
            workType: o.workType,
            teeth: o.toothNumbers,
            sentDate: o.sentDate,
            dueDate: o.dueDate,
            systemCostMinor: o.costMinor || 0,
            currency: (o.costCurrency as Currency) || (party.currency as Currency) || "YER",
            status: o.status,
            financialStatus: o.financialStatus || "pending_delivery",
            notes: o.details,
          }));
          return {
            status: 200,
            body: {
              party,
              orders: reconcileItems,
              unsettledCount: reconcileItems.filter((i) => i.financialStatus !== "paid").length,
              risks: risks.filter((r) => r.labName === party.name),
            },
          };
        }

        const labStats = labParties.map((party) => {
          const partyOrders = allOrders.filter(
            (o) => (o.partyId === party.id || o.labName === party.name) && o.isPosted !== false,
          );
          const unsettled = partyOrders.filter((o) => o.financialStatus !== "paid");
          return {
            partyId: party.id,
            partyName: party.name,
            currency: party.currency,
            phone: party.phone,
            activeOrdersCount: partyOrders.filter(
              (o) => o.status === "sent" || o.status === "in_progress" || o.status === "received",
            ).length,
            unsettledOrdersCount: unsettled.length,
          };
        });

        return {
          status: 200,
          body: {
            labs: labStats,
            financialSummary: { state: "unavailable", reason: "use_authorized_financial_read" },
            clinicalScope: { kind: "loaded_global_window", limit: 300 },
            risks,
            totalRisksCount: risks.length,
          },
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
  } catch (error) {
    if (hasView) {
      const refusal = staffAdmissionRefusal(error);
      if (refusal) {
        return NextResponse.json(
          { code: refusal.code, message: refusal.message },
          { status: refusal.status, headers: NO_STORE },
        );
      }
      return NextResponse.json(
        { message: "تعذّر التحقق من أرصدة المختبرات." },
        { status: 503, headers: NO_STORE },
      );
    }
    return handleSlice37bError(error, "تعذّر تحميل بيانات المطابقة.");
  }
}

export async function labReconciliationPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "finance.reconciliation.manage",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.reconciliation.manage");
        const caps = await staffOperationCapabilities(
          client,
          handle,
          "finance.reconciliation.manage",
          ["finance.fx.manage"] as const,
        );

        let body: unknown;
        try {
          body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { status: 400, body: { message: "طلب غير صالح." } };
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return { status: 400, body: { message: "طلب غير صالح." } };
        }
        const source = body as Record<string, unknown>;
        const positiveSafeInteger = (
          value: unknown,
          maximum = Number.MAX_SAFE_INTEGER,
        ): number | null => {
          if (typeof value !== "number" && (typeof value !== "string" || !/^[0-9]+$/.test(value))) {
            return null;
          }
          const parsed = typeof value === "number" ? value : Number(value);
          return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : null;
        };

        const partyId = positiveSafeInteger(source.partyId, 2_147_483_647);
        if (partyId === null) {
          return { status: 400, body: { message: "يرجى تحديد المختبر." } };
        }
        if (!Array.isArray(source.orderIds) || source.orderIds.length === 0) {
          return {
            status: 400,
            body: { message: "يرجى تحديد أمر عمل واحد على الأقل للمطابقة والتسوية." },
          };
        }
        const orderIds: number[] = [];
        for (const value of source.orderIds) {
          const id = positiveSafeInteger(value, 2_147_483_647);
          if (id === null) {
            return { status: 400, body: { message: "أرقام أوامر المختبر غير صالحة." } };
          }
          orderIds.push(id);
        }
        const amountMinor = positiveSafeInteger(source.amountMinor);
        if (amountMinor === null) {
          return { status: 400, body: { message: "مبلغ التسوية غير صالح." } };
        }
        if (!isCurrency(source.currency)) {
          return { status: 400, body: { message: "اختر عملة التسوية." } };
        }
        const currency: Currency = source.currency;
        if (
          source.exchangeRate !== undefined &&
          (typeof source.exchangeRate !== "number" ||
            !Number.isFinite(source.exchangeRate) ||
            source.exchangeRate <= 0)
        ) {
          return { status: 400, body: { message: "سعر الصرف غير صالح." } };
        }
        const monthLabel =
          typeof source.monthLabel === "string" ? source.monthLabel.trim() : undefined;
        const note =
          typeof source.note === "string" && source.note.trim() ? source.note.trim() : null;
        const prepaymentReason =
          source.prepayment === true &&
          typeof source.prepaymentReason === "string" &&
          source.prepaymentReason.trim().length >= 3
            ? source.prepaymentReason.trim().slice(0, 300)
            : null;
        if (source.prepayment === true && !prepaymentReason) {
          return {
            status: 400,
            body: { message: "اكتب سبب الدفعة المقدمة — يُحفظ في السند ويُدقَّق." },
          };
        }

        const settingsRates = ratesFromSettings(await getSettingsInTransaction(client));
        const settingsRate = rateOf(currency, settingsRates);
        const overrideRaw = typeof source.exchangeRate === "number" ? source.exchangeRate : null;
        const overridden =
          currency !== CLINIC_BASE_CURRENCY &&
          overrideRaw !== null &&
          overrideRaw > 0 &&
          overrideRaw !== settingsRate;
        if (overridden && !caps.has("finance.fx.manage")) {
          return {
            status: 403,
            body: { message: "تجاوز سعر الصرف للمخوّل بإدارة العملات فقط." },
          };
        }
        const rateOverrideReason =
          typeof source.rateOverrideReason === "string" &&
          source.rateOverrideReason.trim().length >= 3
            ? source.rateOverrideReason.trim().slice(0, 300)
            : null;
        if (overridden && !rateOverrideReason) {
          return {
            status: 400,
            body: { message: "اكتب سبب اختلاف سعر الصرف عن سعر الإعدادات — يُحفظ في السند ويُدقَّق." },
          };
        }
        const exchangeRate = overridden ? overrideRaw! : settingsRate;
        if (exchangeRate === null) {
          return {
            status: 409,
            body: { message: "سعر الصرف غير مضبوط. اضبطه في الإعدادات قبل الصرف بعملة أجنبية." },
          };
        }

        const baseCurrency: Currency = CLINIC_BASE_CURRENCY;
        const result = await settleLabOrdersBatchInTx(client, {
          partyId,
          orderIds,
          amountMinor,
          currency,
          baseCurrency,
          exchangeRate,
          note,
          monthLabel,
          createdBy: identity.username,
          actorRole: identity.role,
          rates: settingsRates,
          rateOverrideReason: overridden ? rateOverrideReason : null,
          prepaymentReason,
        });

        if (!result.ok) {
          if (
            result.reason === "batch_link_invalid" ||
            result.reason === "batch_currency_mismatch" ||
            result.reason === "batch_requires_full_allocation" ||
            result.reason === "batch_busy"
          ) {
            const batchMessages = {
              batch_link_invalid:
                "تعذّرت مطابقة التزامات الأوامر. حدّث البيانات واستخدم سداد الفاتورة منفردة عند الحاجة.",
              batch_currency_mismatch:
                "التسوية المجمّعة تتطلب عملة واحدة مطابقة للدفع. استخدم سداد الفاتورة منفردة للعملات المختلفة.",
              batch_requires_full_allocation:
                "التسوية المجمّعة تتطلب كامل المتبقي للأوامر المحددة بالضبط. حدّث البيانات أو استخدم سداد الفاتورة منفردة.",
              batch_busy:
                "توجد عملية أخرى على بيانات التسوية. حدّث البيانات وتحقّق من الحالة قبل إعادة المحاولة.",
            };
            return {
              status: 409,
              body: { code: result.reason, message: batchMessages[result.reason], quote: null },
            };
          }
          const ids = result.orderIds?.map((id) => `RX-${id}`).join("، ") ?? "";
          const byReason: Record<string, [number, string]> = {
            not_lab: [404, "جهة المختبر غير مسجلة بالنظام."],
            orders_invalid: [409, `أوامر لا تخص هذا المختبر أو غير موجودة: ${ids}.`],
            orders_cancelled: [409, `أوامر ملغاة لا تُسدَّد: ${ids}.`],
            orders_already_paid: [409, `أوامر مسدّدة من قبل — لا تُسدَّد مرتين: ${ids}.`],
          };
          const [status, message] = byReason[result.reason] ?? [
            refusalStatus(result.reason),
            refusalMessage(result.reason as SupplierPaymentRefusal, result.quote),
          ];
          return {
            status,
            body: { message, code: result.reason, orderIds: result.orderIds, quote: result.quote },
          };
        }

        const expense = result.expense;
        await insertAuditRow(client, {
          action: "expense.create",
          actor: identity.username,
          actorRole: identity.role,
          entity: "expense",
          entityId: expense.id,
          entityLabel: expense.voucherNumber,
          details: {
            type: "lab_batch_reconciliation",
            partyId,
            partyName: result.partyName,
            voucherNumber: expense.voucherNumber,
            settledOrdersCount: result.orderIds.length,
            orderIds: result.orderIds,
            amountMinor,
            currency,
            سعر_الدفع: expense.exchangeRate,
            المكافئ: expense.baseAmountMinor,
          },
        });
        if (expense.rateOverrideReason) {
          await insertAuditRow(client, {
            action: "expense.rate_override",
            entity: "expense",
            entityId: expense.id,
            entityLabel: expense.voucherNumber,
            details: {
              العملة: currency,
              سعر_الإعدادات: settingsRate,
              السعر_المستعمل: expense.exchangeRate,
              السبب: expense.rateOverrideReason,
            },
            actor: identity.username,
            actorRole: identity.role,
          });
        }
        if (result.quote?.party?.prepayment) {
          await insertAuditRow(client, {
            action: "expense.prepayment",
            entity: "expense",
            entityId: expense.id,
            entityLabel: expense.voucherNumber,
            details: {
              الجهة: partyId,
              المبلغ: amountMinor,
              العملة: currency,
              المستحق_قبل: result.quote.party.outstandingBeforeMinor,
              السبب: prepaymentReason,
            },
            actor: identity.username,
            actorRole: identity.role,
          });
        }

        return {
          status: 200,
          body: {
            ok: true,
            voucherNumber: expense.voucherNumber,
            expenseId: expense.id,
            settledCount: result.orderIds.length,
            totalPaidMinor: amountMinor,
            currency,
            message: `تم بنجاح سداد وتسوية ${result.orderIds.length} أمر مختبر بسند صرف رقم ${expense.voucherNumber}.`,
          },
        };
      },
    );
    return toTxJsonResponse(outcome);
  } catch (error) {
    return handleSlice37bError(error, "تعذّر إتمام التسوية المجمعة للمختبر.");
  }
}

export async function reconciliationGetCanonicalResponse(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "finance.reconciliation.view",
      async (query) => {
        const baseCurrency: Currency = CLINIC_BASE_CURRENCY;
        const openShift = await getOpenShiftWith(query, false);
        let currentShiftSummary = null;
        if (openShift) {
          const [payments, expenses, drawer] = await Promise.all([
            listShiftPaymentsWith(query, openShift.id),
            listShiftExpensesWith(query, openShift.id),
            shiftDrawerBreakdown(openShift, query),
          ]);
          currentShiftSummary = {
            shift: openShift,
            paymentsCount: payments.length,
            expensesCount: expenses.length,
            income: drawer.cashIn,
            refunds: drawer.cashRefunds,
            nonCashIn: drawer.nonCashIn,
            nonCashRefunds: drawer.nonCashRefunds,
            expenses: drawer.spent,
            expected: drawer.expected,
          };
        }
        const pastShifts = await listShiftsWith(query, 30);
        return {
          clinicTimeZone: CLINIC_TIME_ZONE,
          baseCurrency,
          openShift: currentShiftSummary,
          shifts: pastShifts,
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37bError(error, "فشل جلب بيانات المطابقة.");
  }
}

export async function financeReportGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const from = DATE_PATTERN.test(params.get("from") ?? "") ? params.get("from")! : today;
  const to = DATE_PATTERN.test(params.get("to") ?? "") ? params.get("to")! : today;
  const [start, end] = from <= to ? [from, to] : [to, from];

  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "reports.financial.view",
      async (query, scope) => {
        const summary = await financeSummaryWith(query, start, end);
        const canSeeExpenses = scope.granted("finance.expenses.view");
        return projectFinanceSummary(summary, {
          revenue: true,
          expenses: canSeeExpenses,
          profit: canSeeExpenses && scope.granted("finance.profits.view"),
        });
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37bError(error, "تعذّر تحميل التقرير.");
  }
}

/* ============================================================================
 * 6. PARTIES & PAYABLES (/api/parties/**, /api/payables)
 * ============================================================================ */

export async function partiesGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const kind = new URL(request.url).searchParams.get("kind");
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "read:parties",
      async (query, scope) => {
        const canSeeEmployees =
          scope.granted("hr.payroll.manage") ||
          scope.granted("reports.financial.view") ||
          scope.granted("finance.parties.manage");
        if (kind === "employee" && !canSeeEmployees) {
          return [];
        }
        const parties = await listPartiesWith(query, isPartyKind(kind) ? kind : undefined);
        const visible = canSeeEmployees ? parties : parties.filter((p) => p.kind !== "employee");
        const canSeeAllCommissionRates =
          scope.granted("finance.commissions.manage-rates") ||
          scope.granted("finance.commissions.view-all") ||
          scope.granted("finance.parties.manage");
        if (canSeeAllCommissionRates) {
          return visible;
        }
        return visible.map((p) => {
          if (p.kind === "doctor" && p.id !== scope.clinicianPartyId) {
            return { ...p, commissionPercent: 0 };
          }
          return p;
        });
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return handleSlice37bError(error, "تعذّر تحميل الجهات.");
  }
}

export async function partiesPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "finance.parties.manage",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.parties.manage");

        let body: unknown;
        try {
          body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { status: 400, body: { message: "طلب غير صالح." } };
        }
        const source = (body ?? {}) as Record<string, unknown>;

        const name = typeof source.name === "string" ? source.name.trim() : "";
        if (!name || name.length > 120) {
          return { status: 400, body: { message: "اكتب اسم الجهة." } };
        }
        if (!isPartyKind(source.kind)) {
          return { status: 400, body: { message: "اختر نوع الجهة." } };
        }
        const percentRaw = Number(
          String(source.commissionPercent ?? 0).replace(/[٠-٩]/g, (d) =>
            String(d.charCodeAt(0) - 0x0660),
          ),
        );
        if (!Number.isFinite(percentRaw) || percentRaw < 0 || percentRaw > 100) {
          return { status: 400, body: { message: "النسبة بين 0 و100." } };
        }
        const phone =
          typeof source.phone === "string" && source.phone.trim()
            ? source.phone.trim().slice(0, 40)
            : null;
        const note =
          typeof source.note === "string" && source.note.trim()
            ? source.note.trim().slice(0, 300)
            : null;

        const party = await createPartyInTx(
          client,
          { name, kind: source.kind, phone, commissionPercent: percentRaw, note },
          { actor: identity.username, actorRole: identity.role, reason: "إنشاء جهة" },
        );
        await insertAuditRow(client, {
          action: "party.create",
          entity: "party",
          entityId: party.id,
          entityLabel: party.name,
          details: auditSnapshot(party as unknown as Record<string, unknown>, PARTY_AUDIT_FIELDS),
          actor: identity.username,
          actorRole: identity.role,
        });
        return { status: 201, body: party };
      },
    );
    return toTxJsonResponse(outcome);
  } catch (error) {
    return handleSlice37bError(error, "تعذّر حفظ الجهة.");
  }
}

export async function partyPatchCanonicalResponse(
  request: Request,
  rawId: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "finance.parties.manage",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.parties.manage");

        const id = Number(rawId);
        if (!Number.isInteger(id) || id <= 0) {
          return { status: 400, body: { message: "رقم الجهة غير صالح." } };
        }

        let body: unknown;
        try {
          body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { status: 400, body: { message: "طلب غير صالح." } };
        }
        const source = (body ?? {}) as Record<string, unknown>;

        const patch: {
          name?: string;
          phone?: string | null;
          commissionPercent?: number;
          note?: string | null;
          isActive?: boolean;
        } = {};

        if (typeof source.name === "string") {
          const name = source.name.trim();
          if (!name || name.length > 120) {
            return { status: 400, body: { message: "اكتب اسم الجهة." } };
          }
          patch.name = name;
        }
        if (typeof source.phone === "string") patch.phone = source.phone.trim().slice(0, 40) || null;
        if (typeof source.note === "string") patch.note = source.note.trim().slice(0, 300) || null;
        if (typeof source.isActive === "boolean") patch.isActive = source.isActive;
        if (source.commissionPercent !== undefined) {
          const percent = Number(
            String(source.commissionPercent).replace(/[٠-٩]/g, (d) =>
              String(d.charCodeAt(0) - 0x0660),
            ),
          );
          if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
            return { status: 400, body: { message: "النسبة بين 0 و100." } };
          }
          patch.commissionPercent = percent;
        }

        if (Object.keys(patch).length === 0) {
          return { status: 400, body: { message: "لا يوجد ما يُحدَّث." } };
        }

        const reason =
          typeof source.reason === "string" && source.reason.trim()
            ? source.reason.trim().slice(0, 300)
            : null;
        const before = await getPartyWith(client, id);
        if (!before) {
          return { status: 404, body: { message: "الجهة غير موجودة." } };
        }
        const updated = await updatePartyInTx(client, id, patch, {
          actor: identity.username,
          actorRole: identity.role,
          reason,
        });
        if (!updated) {
          return { status: 404, body: { message: "الجهة غير موجودة." } };
        }

        const changes = auditChanges(
          before as unknown as Record<string, unknown>,
          updated as unknown as Record<string, unknown>,
          PARTY_AUDIT_FIELDS,
        );
        if (Object.keys(changes).length > 0) {
          await insertAuditRow(client, {
            action: "party.update",
            entity: "party",
            entityId: id,
            entityLabel: updated.name,
            details: { ...changes, ...(reason ? { السبب: reason } : {}) },
            actor: identity.username,
            actorRole: identity.role,
          });
        }
        return { status: 200, body: updated };
      },
    );
    return toTxJsonResponse(outcome);
  } catch (error) {
    return handleSlice37bError(error, "تعذّر حفظ التعديل.");
  }
}

export async function payablesGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const nativeView = params.has("view");
  const partyId = Number(params.get("partyId"));

  try {
    const result = await runCanonicalReadSnapshot(
      session,
      "finance.suppliers.view",
      async (query) => {
        if (
          nativeView &&
          (params.getAll("view").length !== 1 ||
            params.get("view") !== "party-balances-v1" ||
            [...params.keys()].some((key) => key !== "view"))
        ) {
          return { status: 400, body: { message: "نطاق أرصدة الجهات غير صالح." } };
        }
        if (nativeView) {
          const snapshot = await loadPartyNativeBalanceSnapshot(query);
          return {
            status: 200,
            body: {
              view: "party-balances-v1",
              partyIdentities: snapshot.partyIdentities,
              balancesByCurrency: snapshot.balancesByCurrency,
              observedAt: new Date().toISOString(),
            },
          };
        }
        const baseCurrency = CLINIC_BASE_CURRENCY;
        if (Number.isInteger(partyId) && partyId > 0) {
          const [party, statement] = await Promise.all([
            getPartyWith(query, partyId),
            partyStatementWith(query, partyId),
          ]);
          if (!party) {
            return { status: 404, body: { message: "الجهة غير موجودة." } };
          }
          return {
            status: 200,
            body: {
              ...statement,
              baseCurrency,
              party: { id: party.id, name: party.name, kind: party.kind, phone: party.phone },
            },
          };
        }
        return {
          status: 200,
          body: { balances: await partyBalancesWith(query), baseCurrency },
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
  } catch (error) {
    return handleSlice37bError(error, "تعذّر تحميل المستحقات.");
  }
}

export async function payablesPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "finance.payables.record",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.payables.record");

        let body: unknown;
        try {
          body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { status: 400, body: { message: "طلب غير صالح." } };
        }
        const source = (body ?? {}) as Record<string, unknown>;

        const partyId = Number(source.partyId);
        if (!Number.isInteger(partyId) || partyId <= 0) {
          return { status: 400, body: { message: "اختر الجهة." } };
        }
        const description = typeof source.description === "string" ? source.description.trim() : "";
        if (!description || description.length > 200) {
          return { status: 400, body: { message: "اكتب بيان الالتزام." } };
        }
        const currency = isCurrency(source.currency) ? source.currency : null;
        if (!currency) return { status: 400, body: { message: "اختر العملة." } };

        const amountMinor = parseAmount(String(source.amount ?? ""), currency);
        if (amountMinor === null || amountMinor === 0) {
          return { status: 400, body: { message: "اكتب مبلغًا أكبر من صفر." } };
        }

        const dueDate =
          typeof source.dueDate === "string" && DATE_PATTERN.test(source.dueDate)
            ? source.dueDate
            : null;
        const requestedCategory =
          typeof source.category === "string" && source.category.trim()
            ? source.category.trim().slice(0, 40)
            : null;

        const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
        if (await isPeriodLockedWith(client, today)) {
          return {
            status: 409,
            body: { message: "الفترة المحاسبية مقفلة. لا يمكن تسجيل التزام جديد في فترة مقفلة." },
          };
        }
        const settings = await getSettingsInTransaction(client);
        const base = CLINIC_BASE_CURRENCY;
        const exchangeRate = rateFromSettings(settings, currency, base);
        if (exchangeRate === null) {
          return { status: 409, body: { message: "سعر الصرف غير مضبوط في الإعدادات." } };
        }

        return withCanonicalHttpIdempotencyInTx(
          client,
          request,
          "payables.create",
          identity.username,
          source,
          async () => {
            const party = await getPartyWith(client, partyId);
            if (!party) {
              return { status: 404, body: { message: "الجهة غير موجودة." } };
            }
            const category = requestedCategory ?? (party.kind === "lab" ? "lab" : "supplier");
            const payable = await createPayableInTransaction(client, {
              partyId,
              category,
              description,
              amountMinor,
              currency,
              baseCurrency: base,
              exchangeRate,
              labOrderId: null,
              dueDate,
              createdBy: identity.username,
            });
            if (!payable) {
              return { status: 500, body: { message: "تعذّر حفظ الالتزام." } };
            }
            await insertAuditRow(client, {
              action: "payable.create",
              entity: "payable",
              entityId: payable.id,
              entityLabel: payable.description,
              details: {
                الجهة: payable.partyName,
                البيان: payable.description,
                المبلغ: payable.amountMinor,
                العملة: payable.currency,
                سعر_الصرف: payable.exchangeRate,
                المكافئ: payable.baseAmountMinor,
                الاستحقاق: payable.dueDate,
                التصنيف: payable.category,
              },
              actor: identity.username,
              actorRole: identity.role,
            });
            return { status: 201, body: payable };
          },
        );
      },
    );
    return toTxJsonResponse(outcome);
  } catch (error) {
    return handleSlice37bError(error, "تعذّر حفظ الالتزام. تأكد من الجهة.");
  }
}
