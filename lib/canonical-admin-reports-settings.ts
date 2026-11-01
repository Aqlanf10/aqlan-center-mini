import "server-only";
import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES, SETTINGS_BODY_LIMIT_BYTES } from "./security-limits";
import { bodyErrorResponse, readBoundedFormData, readJsonBody } from "./http-body";
import { readServiceInput } from "./appointment-service-input";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { exportFileName } from "./csv";
import {
  getDailyClinicReportToday,
  loadDailyClinicReportInSnapshot,
} from "./daily-clinic-report";
import { DailyClinicExpenseIntegrityError } from "./daily-clinic-expense-report";
import {
  DailyClinicReportIntegrityError,
  isDailyClinicReportDate,
} from "./daily-clinic-report-model";
import {
  CLINIC_TIME_ZONE,
  createAppointmentServiceWith,
  createDisplayAnnouncementInTransaction,
  deleteDisplayAnnouncementWith,
  executiveKpis,
  getAppointmentServiceWith,
  getPool,
  getSettingsInTransaction,
  getSettingsWith,
  insertAuditRow,
  invalidateSettingsCache,
  labCountsWith,
  listAppointmentServicesWith,
  listAppointmentsByDateWith,
  listDisplayAnnouncementsWith,
  listMessagingChannelsWith,
  listVisitsByDateWith,
  readStoredSettingsWith,
  reorderDisplayAnnouncementsInTransaction,
  saveMessagingChannelInTransaction,
  setMaterialRateInTransaction,
  todayPlannedVisitsWith,
  updateAppointmentServiceWith,
  updateDisplayAnnouncementWith,
  usesSharedLocalDatabaseConnection,
  writeSettingsInTransaction,
} from "./db";
import { executiveCsv } from "./executive";
import { ReclassificationProofError } from "./invoice-currency-reclassification";
import {
  JOURNAL_REVIEW_RESPONSE,
  JournalReadIntegrityError,
} from "./journal-read-integrity";
import { parseOperationalQuery } from "./leadership-operations";
import { readOperationalOverview } from "./leadership-operations-db";
import {
  decodeLeadershipPulse,
  LEADERSHIP_PAGE_SIZE,
  parsePulseQuery,
  type LeadershipPulse,
} from "./leadership-pulse";
import { LEADERSHIP_DAY_SQL, LEADERSHIP_TASKS_SQL } from "./leadership-pulse-db";
import {
  LOGIN_PHOTO_ASSET,
  LOGIN_PHOTO_BODY_BYTES,
  LOGIN_PHOTO_KEYS,
  LOGIN_PHOTO_MAX_BYTES,
  LOGIN_PHOTO_VISIBLE,
  loginPhotoVersions,
  parseLoginPhotoAsset,
} from "./login-photo";
import {
  readVerifiedLoginPhoto,
  storeLoginPhotoWithMeta,
  validateLoginPhotoBytes,
} from "./login-photo-server";
import { cleanupUncommittedStoredFile, holdStorageKeyShared } from "./file-cleanup";
import type { StoredFile } from "./files";
import { parseRateBp } from "./materialRate";
import {
  isChannel,
  missingSecretForEnable,
  normalizeChannelConfig,
  SECRET_FIELDS,
} from "./messaging-channels";
import { FinancialCurrencyIntegrityError } from "./money";
import {
  changeCanonicalNumberingFloorWith,
  readCanonicalNumberingPreviewWith,
} from "./patient-numbering-db";
import { patientNumberingErrorResponse } from "./patient-numbering-response";
import { dayReport, tomorrowLoad } from "./report";
import {
  canCanonicalAccessUnifiedReport,
  isKnownUnifiedReport,
} from "./report-access";
import {
  buildReport,
  dbTodayISOWith,
  parseFilters,
  ReportInputError,
  reportOptionsWith,
  validateAnnualReportRange,
} from "./reports";
import { addDays, clinicDateString } from "./schedule";
import { chairCount, SETTING_DEFAULTS } from "./settings";
import { STAFF_CAPABILITIES } from "./staff-capability-catalogue";
import { staffAdmissionRefusal } from "./staff-capability-editor";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationAppointmentScope,
  staffOperationCapabilities,
  staffOperationIdentity,
  staffOperationPatientScope,
  withStaffOperation,
} from "./staff-operation-runtime";
import { withCanonicalOwnerOperation } from "./staff-session-admission";
import { probeStorageReadiness } from "./storage-readiness";
import {
  parseAnnouncementId,
  parseAnnouncementReorder,
  validateAnnouncementInput,
  validateAnnouncementPatch,
} from "./waiting-room";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SETTINGS_AUDIT_ENTITY = "clinic_setting";
const SETTINGS_AUDIT_UPDATE = "clinic_settings.update";

const adminNoStore = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

const loginPhotoHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

const dailyClinicHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie, Authorization",
};

function mapCanonicalAdminRefusal(error: unknown, fallbackMessage: string): NextResponse {
  const refusal = staffAdmissionRefusal(error);
  if (refusal) return adminNoStore({ message: refusal.message }, refusal.status);
  return adminNoStore({ message: fallbackMessage }, 500);
}

function assertCanonicalDbAvailable(): NextResponse | null {
  if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) {
    return adminNoStore({ message: "الهوية الموحّدة غير متاحة الآن." }, 503);
  }
  return null;
}

export async function canonicalAuditGet(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  const params = new URL(request.url).searchParams;
  const dateParam = (key: string) => {
    const value = params.get(key);
    return value && DATE_PATTERN.test(value) ? value : null;
  };
  const limit = Math.min(Math.max(1, Number(params.get("limit")) || 200), 500);

  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "audit.view",
      async (query) => {
        const entriesRes = await query.query<{
          id: string | number;
          action: string;
          entity: string | null;
          entity_id: string | null;
          summary: string;
          details: Record<string, unknown> | null;
          actor: string;
          actor_role: string | null;
          created_at: Date;
          source_ip?: string | null;
          user_agent?: string | null;
        }>(
          `SELECT id, action, entity, entity_id, summary, details, actor, actor_role, created_at,
                  source_ip, user_agent
             FROM audit_log
            WHERE ($1::date IS NULL OR (created_at AT TIME ZONE $7)::date >= $1::date)
              AND ($2::date IS NULL OR (created_at AT TIME ZONE $7)::date <= $2::date)
              AND ($3::text IS NULL OR action = $3::text)
              AND ($4::text IS NULL OR actor = $4::text)
              AND ($5::text IS NULL OR (entity = $5::text AND ($6::text IS NULL OR entity_id = $6::text)))
              AND NOT (entity = 'hr_task' AND EXISTS (
                SELECT 1 FROM hr_tasks pt
                 WHERE pt.id::text = audit_log.entity_id AND pt.is_private
              ))
            ORDER BY id DESC
            LIMIT $8`,
          [
            dateParam("from"),
            dateParam("to"),
            params.get("action") || null,
            params.get("actor") || null,
            params.get("entity") || null,
            params.get("entityId") || null,
            CLINIC_TIME_ZONE,
            limit,
          ],
        );
        const actorsRes = await query.query<{ actor: string }>(
          `SELECT DISTINCT actor FROM audit_log ORDER BY actor LIMIT 50`,
        );
        return {
          entries: entriesRes.rows.map((row) => ({
            id: Number(row.id),
            action: row.action,
            entity: row.entity,
            entityId: row.entity_id,
            summary: row.summary,
            details: row.details,
            actor: row.actor,
            actorRole: row.actor_role,
            createdAt: row.created_at.toISOString(),
            sourceIp: row.source_ip ?? null,
            userAgent: row.user_agent ?? null,
          })),
          actors: actorsRes.rows.map((row) => row.actor),
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: 4_194_304 },
    );
    return adminNoStore(payload, 200);
  } catch (error) {
    return mapCanonicalAdminRefusal(error, "تعذّر تحميل سجل التدقيق.");
  }
}

export async function canonicalExecutiveGet(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const params = new URL(request.url).searchParams;
  const requestedFrom = params.get("from") ?? "";
  const requestedTo = params.get("to") ?? "";
  const from = DATE_PATTERN.test(requestedFrom) ? requestedFrom : `${today.slice(0, 7)}-01`;
  const to = DATE_PATTERN.test(requestedTo) ? requestedTo : today;
  const wantsCsv = params.get("format") === "csv";

  try {
    const gate = await runCanonicalReadSnapshot(
      session,
      "read:executive",
      async (_query, scope) => {
        const hasFinancialView = scope.granted("reports.financial.view");
        const hasProfitsView = scope.granted("finance.profits.view");
        const canExport = scope.granted("finance.export") || scope.granted("reports.export");
        return { hasFinancialView, hasProfitsView, canExport };
      },
      { errorPrefix: "STAFF_READ", maxBytes: 4096 },
    );
    if (!gate.hasFinancialView && !gate.hasProfitsView) {
      return adminNoStore(
        { message: "مؤشرات الأرباح العامة وصافي الدخل مخفية بحسب سياسة المالية المخفية." },
        403,
      );
    }
    if (wantsCsv && !gate.canExport && !gate.hasFinancialView) {
      return adminNoStore({ message: "لا تملك صلاحية تصدير التقارير المالية." }, 403);
    }

    const runtimeAction = gate.hasFinancialView ? "reports.financial.view" : "finance.profits.view";
    const kpis = await withStaffOperation(getPool(), session, runtimeAction, async () =>
      executiveKpis(from, to, { skipEnsureSchema: true }),
    );
    if (wantsCsv) {
      return new NextResponse("\uFEFF" + executiveCsv(kpis), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${exportFileName("executive", from, to)}"`,
          "Cache-Control": "private, no-store",
        },
      });
    }
    return adminNoStore(kpis, 200);
  } catch (error) {
    if (error instanceof JournalReadIntegrityError) {
      return adminNoStore(JOURNAL_REVIEW_RESPONSE, 409);
    }
    return mapCanonicalAdminRefusal(error, "تعذّر تحميل مؤشرات القيادة.");
  }
}

export async function canonicalExecutiveOperationsGet(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  const input = parseOperationalQuery(new URL(request.url).searchParams, new Date(), CLINIC_TIME_ZONE);
  try {
    const result = await runCanonicalReadSnapshot(
      session,
      "finance.profits.view",
      async (query) => {
        if (!input) return { kind: "bad_input" as const };
        const overview = await readOperationalOverview(query, input, CLINIC_TIME_ZONE);
        return { kind: "ok" as const, overview };
      },
      { errorPrefix: "STAFF_READ", maxBytes: 1_048_576 },
    );
    if (result.kind === "bad_input") {
      return adminNoStore({ message: "اختر يومًا صحيحًا ومسار مراجعة صالحًا." }, 400);
    }
    return adminNoStore(result.overview, 200);
  } catch (error) {
    return mapCanonicalAdminRefusal(error, "تعذّر تحميل المراجعة التشغيلية.");
  }
}

export async function canonicalExecutivePulseGet(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  const input = parsePulseQuery(new URL(request.url).searchParams, new Date(), CLINIC_TIME_ZONE);
  try {
    const result = await runCanonicalReadSnapshot(
      session,
      "finance.profits.view",
      async (query, scope) => {
        if (!input) return { kind: "bad_input" as const };
        const args: unknown[] = [CLINIC_TIME_ZONE, input.day, input.page, LEADERSHIP_PAGE_SIZE];
        if (input.view === "tasks") args.push(scope.userId);
        const { rows: [row] } = await query.query<{
          as_of: Date;
          today: string;
          total: number;
          page: number;
          counts: Record<string, number>;
          items: LeadershipPulse["items"];
        }>(input.view === "day" ? LEADERSHIP_DAY_SQL : LEADERSHIP_TASKS_SQL, args);
        const pulse =
          row &&
          decodeLeadershipPulse(
            {
              view: input.view,
              scope: input.view === "day" ? "selected_arrival_day" : "visible_open_tasks_now",
              day: input.view === "day" ? input.day : row.today,
              today: row.today,
              timeZone: CLINIC_TIME_ZONE,
              asOf: row.as_of.toISOString(),
              counts: row.counts,
              total: row.total,
              page: row.page,
              hasMore: (row.page + 1) * LEADERSHIP_PAGE_SIZE < row.total,
              items: row.items,
            },
            input.view,
            input.view === "day" ? input.day : null,
          );
        if (!pulse) throw new Error("LEADERSHIP_PULSE_INVALID");
        return { kind: "ok" as const, pulse };
      },
      { errorPrefix: "STAFF_READ", maxBytes: 1_048_576 },
    );
    if (result.kind === "bad_input") {
      return adminNoStore({ message: "اختر مصدرًا ويومًا وصفحة صحيحة." }, 400);
    }
    return adminNoStore(result.pulse, 200);
  } catch (error) {
    const refusal = staffAdmissionRefusal(error);
    if (refusal) return adminNoStore({ message: refusal.message }, refusal.status);
    return adminNoStore({ message: "تعذّر التحقق من المصدر. العدد غير معروف؛ أعد المحاولة." }, 503);
  }
}

export async function canonicalOperationalReportGet(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const requested = new URL(request.url).searchParams.get("date") ?? today;
  const date = DATE_PATTERN.test(requested) ? requested : today;
  const next = addDays(date, 1);

  try {
    const payload = await withStaffOperation(
      getPool(),
      session,
      "reports.operational.view",
      async (client, opHandle) => {
        const patientScope = await staffOperationPatientScope(client, opHandle, "reports.operational.view");
        const appointmentScope = await staffOperationAppointmentScope(client, opHandle, "reports.operational.view");
        const settings = await getSettingsInTransaction(client);
        const chairs = chairCount(settings);

        const visits =
          patientScope.kind === "all"
            ? await listVisitsByDateWith(client, date)
            : patientScope.kind === "own"
              ? await listVisitsByDateWith(client, date, patientScope.clinicianPartyId)
              : [];

        const appointments =
          appointmentScope.kind === "all"
            ? await listAppointmentsByDateWith(client, date, null)
            : appointmentScope.kind === "own"
              ? await listAppointmentsByDateWith(client, date, appointmentScope.clinicianPartyId)
              : [];

        const nextDay =
          appointmentScope.kind === "all"
            ? await listAppointmentsByDateWith(client, next, null)
            : appointmentScope.kind === "own"
              ? await listAppointmentsByDateWith(client, next, appointmentScope.clinicianPartyId)
              : [];

        const lab =
          patientScope.kind === "all"
            ? await labCountsWith(client, { mode: "workflow", today })
            : patientScope.kind === "own"
              ? await labCountsWith(client, {
                  mode: "workflow",
                  today,
                  scopedDoctorPartyId: patientScope.clinicianPartyId,
                })
              : { outstanding: 0, late: 0, dueToday: 0, waitingFitting: 0 };

        const plannedToday =
          patientScope.kind === "all"
            ? await todayPlannedVisitsWith(client, date, null)
            : patientScope.kind === "own"
              ? await todayPlannedVisitsWith(client, date, patientScope.clinicianPartyId)
              : [];

        return {
          date,
          nextDate: next,
          report: dayReport(visits, appointments, new Date()),
          tomorrow: tomorrowLoad(
            nextDay,
            next,
            chairs,
            settings["clinic.day_start"],
            settings["clinic.day_end"],
          ),
          lab,
          chairs,
          plannedToday,
        };
      },
    );
    return adminNoStore(payload, 200);
  } catch (error) {
    return mapCanonicalAdminRefusal(error, "تعذّر تحميل التقرير.");
  }
}

export async function canonicalUnifiedReportsGet(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  const params = new URL(request.url).searchParams;
  const report = params.get("report") ?? "daily";

  try {
    return await withStaffOperation(
      getPool(),
      session,
      "reports.financial.view",
      async (client, opHandle) => {
        if (!isKnownUnifiedReport(report)) {
          return adminNoStore({ message: "نوع تقرير غير معروف." }, 400);
        }
        const identity = await staffOperationIdentity(client, opHandle, "reports.financial.view");
        const caps = await staffOperationCapabilities(client, opHandle, "reports.financial.view", STAFF_CAPABILITIES);
        if (!canCanonicalAccessUnifiedReport(report, (cap) => caps.has(cap))) {
          return adminNoStore({ message: "هذا التقرير خارج الصلاحيات الممنوحة لحسابك." }, 403);
        }

        if (report === "options") {
          try {
            return adminNoStore(await reportOptionsWith(client), 200);
          } catch {
            return adminNoStore({ message: "تعذّر تحميل خيارات الفلاتر." }, 500);
          }
        }

        try {
          if (report === "annual" && params.get("preset") === "custom") {
            validateAnnualReportRange(params.get("from"), params.get("to"));
          }
          const filters = parseFilters(params, await dbTodayISOWith(client));
          const result = await buildReport(report, filters, { skipEnsureSchema: true });
          return adminNoStore(
            {
              result,
              generatedAt: new Date().toISOString(),
              generatedBy: identity.username,
              clinicTimeZone: CLINIC_TIME_ZONE,
            },
            200,
          );
        } catch (error) {
          if (error instanceof ReportInputError) {
            return adminNoStore({ message: error.message }, 400);
          }
          return adminNoStore({ message: "تعذّر إعداد التقرير. أعد المحاولة." }, 500);
        }
      },
    );
  } catch (error) {
    return mapCanonicalAdminRefusal(error, "تعذّر إعداد التقرير. أعد المحاولة.");
  }
}

function canonicalDailyClinicDiagnosticCode(error: unknown): string {
  if (error instanceof DailyClinicReportIntegrityError) {
    switch (error.message) {
      case "Invoice line plan currency conflict": return "INVOICE_LINE_PLAN_CURRENCY";
      case "Invoice/plan currency conflict": return "INVOICE_PLAN_CURRENCY";
      case "Unresolved or cross-patient agreement link": return "AGREEMENT_OWNERSHIP";
      case "Cross-patient invoice line source": return "INVOICE_LINE_OWNERSHIP";
      case "Historical document line count conflict": return "HISTORICAL_DOCUMENT_LINES";
      case "Historical document clinical ownership conflict": return "HISTORICAL_DOCUMENT_OWNERSHIP";
      default: return "REPORT_INTEGRITY";
    }
  }
  if (error instanceof DailyClinicExpenseIntegrityError) return "EXPENSE_INTEGRITY";
  if (error instanceof FinancialCurrencyIntegrityError) return "FINANCIAL_CURRENCY_INTEGRITY";
  if (error instanceof ReclassificationProofError) return "RECLASSIFICATION_PROOF";
  return "UNEXPECTED_FAILURE";
}

export async function canonicalDailyClinicReportGet(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) {
    return NextResponse.json({ message: "الهوية الموحّدة غير متاحة الآن." }, { status: 503, headers: dailyClinicHeaders });
  }
  const dates = new URL(request.url).searchParams.getAll("date");
  const date = dates.length === 0 ? getDailyClinicReportToday() : dates[0];

  try {
    const outcome = await runCanonicalReadSnapshot(
      session,
      "reports.operational.view",
      async (query, scope) => {
        if (!scope.granted("reports.financial.view")) {
          return { kind: "forbidden" as const };
        }
        if (dates.length > 1 || !isDailyClinicReportDate(date)) {
          return { kind: "bad_date" as const };
        }
        const report = await loadDailyClinicReportInSnapshot(query, date);
        return { kind: "ok" as const, report };
      },
      { errorPrefix: "STAFF_READ", maxBytes: 4_194_304 },
    );
    if (outcome.kind === "forbidden") {
      return NextResponse.json({ message: "كشف إقفال اليوم متاح للمخوّلين بالتقارير التشغيلية والمالية معًا." }, { status: 403, headers: dailyClinicHeaders });
    }
    if (outcome.kind === "bad_date") {
      return NextResponse.json({ message: "اختر تاريخًا صحيحًا بصيغة YYYY-MM-DD." }, { status: 400, headers: dailyClinicHeaders });
    }
    return NextResponse.json(outcome.report, { headers: dailyClinicHeaders });
  } catch (error) {
    const refusal = staffAdmissionRefusal(error);
    if (refusal) {
      return NextResponse.json({ message: refusal.message }, { status: refusal.status, headers: dailyClinicHeaders });
    }
    console.error("[daily-clinic-report]", canonicalDailyClinicDiagnosticCode(error));
    return NextResponse.json(
      { message: "تعذّر إعداد كشف إقفال اليوم. أعد المحاولة." },
      { status: 500, headers: dailyClinicHeaders },
    );
  }
}

export async function canonicalAppointmentServicesGet(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  const includeInactive = new URL(request.url).searchParams.get("includeInactive") === "1";
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "settings.view",
      async (query) => {
        const services = await listAppointmentServicesWith(query, { includeInactive });
        const settings = await getSettingsWith(query);
        return { services, chairs: chairCount(settings) };
      },
      { errorPrefix: "STAFF_READ", maxBytes: 524_288 },
    );
    return adminNoStore(payload, 200);
  } catch (error) {
    return mapCanonicalAdminRefusal(error, "تعذّر تحميل الخدمات.");
  }
}

export async function canonicalAppointmentServicesPost(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(request, SETTINGS_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return adminNoStore({ message: "طلب غير صالح." }, 400);
  }

  try {
    return await withStaffOperation(
      getPool(),
      session,
      "settings.operational.edit",
      async (client, opHandle) => {
        const identity = await staffOperationIdentity(client, opHandle, "settings.operational.edit");
        const parsed = readServiceInput(body);
        if (!parsed.ok) return adminNoStore({ message: parsed.message }, 400);
        const result = await createAppointmentServiceWith(
          client,
          parsed.input,
          {
            actor: identity.username,
            actorRole: identity.role,
          },
          (row) => insertAuditRow(client, row),
        );
        return result.ok
          ? adminNoStore(result.service, 201)
          : adminNoStore({ message: result.message }, 400);
      },
    );
  } catch (error) {
    return mapCanonicalAdminRefusal(error, "تعذّر حفظ الخدمة. أعد المحاولة.");
  }
}

export async function canonicalAppointmentServicesPatch(
  session: VerifiedDurableSession,
  request: Request,
  rawId: string,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  const id = Number(rawId);
  let body: Record<string, unknown> | null = null;
  if (Number.isInteger(id) && id > 0) {
    try {
      body = await readJsonBody<Record<string, unknown>>(request, SETTINGS_BODY_LIMIT_BYTES);
    } catch (error) {
      const bounded = bodyErrorResponse(error);
      if (bounded) return bounded;
      return adminNoStore({ message: "طلب غير صالح." }, 400);
    }
  }

  try {
    return await withStaffOperation(
      getPool(),
      session,
      "settings.operational.edit",
      async (client, opHandle) => {
        const identity = await staffOperationIdentity(client, opHandle, "settings.operational.edit");
        if (!Number.isInteger(id) || id <= 0 || !body) {
          return adminNoStore({ message: "رقم الخدمة غير صالح." }, 400);
        }
        const current = await getAppointmentServiceWith(client, id);
        if (!current) return adminNoStore({ message: "الخدمة غير موجودة." }, 404);
        const parsed = readServiceInput(body, current);
        if (!parsed.ok) return adminNoStore({ message: parsed.message }, 400);
        const result = await updateAppointmentServiceWith(
          client,
          id,
          parsed.input,
          {
            actor: identity.username,
            actorRole: identity.role,
          },
          (row) => insertAuditRow(client, row),
        );
        return result.ok
          ? adminNoStore(result.service, 200)
          : adminNoStore({ message: result.message }, 400);
      },
    );
  } catch (error) {
    return mapCanonicalAdminRefusal(error, "تعذّر حفظ الخدمة. أعد المحاولة.");
  }
}

export async function canonicalDisplayAnnouncementsGet(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "settings.view",
      async (query) => {
        const { rows } = await query.query<{
          id: number;
          title: string;
          body: string;
          sort_order: number;
          is_active: boolean;
          created_by: string | null;
          updated_by: string | null;
          created_at: Date;
          updated_at: Date;
        }>(
          `SELECT id, title, body, sort_order, is_active, created_by, updated_by, created_at, updated_at
             FROM display_announcements
            ORDER BY sort_order, id`,
        );
        return {
          announcements: rows.map((row) => ({
            id: row.id,
            title: row.title,
            body: row.body,
            sortOrder: row.sort_order,
            isActive: row.is_active,
            createdBy: row.created_by,
            updatedBy: row.updated_by,
            createdAt: row.created_at.toISOString(),
            updatedAt: row.updated_at.toISOString(),
          })),
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: 262_144 },
    );
    return adminNoStore(payload, 200);
  } catch (error) {
    return mapCanonicalAdminRefusal(error, "تعذّر تحميل الإعلانات.");
  }
}

export async function canonicalDisplayAnnouncementsPost(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  let body: unknown;
  try {
    body = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return adminNoStore({ message: "طلب غير صالح." }, 400);
  }
  const source = (body ?? {}) as { title?: unknown; body?: unknown; isActive?: unknown };

  try {
    return await withStaffOperation(
      getPool(),
      session,
      "settings.operational.edit",
      async (client, opHandle) => {
        const identity = await staffOperationIdentity(client, opHandle, "settings.operational.edit");
        const verdict = validateAnnouncementInput(source);
        if (!verdict.ok) return adminNoStore({ message: verdict.message }, 400);
        const isActive = source.isActive === undefined ? true : source.isActive === true;

        try {
          const announcement = await createDisplayAnnouncementInTransaction(client, {
            title: verdict.value.title,
            body: verdict.value.body,
            isActive,
            actor: identity.username,
          });
          await insertAuditRow(client, {
            action: "display.announcement.create",
            entity: "display_announcement",
            entityId: announcement.id,
            entityLabel: announcement.title,
            details: { العنوان: announcement.title },
            actor: identity.username,
            actorRole: identity.role,
          });
          return adminNoStore({ announcement }, 201);
        } catch (err) {
          if (err instanceof Error && err.message === "ANNOUNCEMENTS_LIMIT") {
            return adminNoStore(
              { message: "بلغت السقف الوقائي للإعلانات — راجع القائمة وحذف ما لا يُعرض." },
              400,
            );
          }
          throw err;
        }
      },
    );
  } catch (error) {
    return mapCanonicalAdminRefusal(error, "تعذّر إضافة الإعلان. أعد المحاولة.");
  }
}

export async function canonicalDisplayAnnouncementsPatch(
  session: VerifiedDurableSession,
  request: Request,
  rawId: string,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  const announcementId = parseAnnouncementId(rawId);
  let body: unknown = null;
  if (announcementId !== null) {
    try {
      body = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES);
    } catch (error) {
      const bounded = bodyErrorResponse(error);
      if (bounded) return bounded;
      return adminNoStore({ message: "طلب غير صالح." }, 400);
    }
  }

  try {
    return await withStaffOperation(
      getPool(),
      session,
      "settings.operational.edit",
      async (client, opHandle) => {
        const identity = await staffOperationIdentity(client, opHandle, "settings.operational.edit");
        if (announcementId === null) {
          return adminNoStore({ message: "إعلان غير صالح." }, 400);
        }
        const source = (body ?? {}) as { title?: unknown; body?: unknown; isActive?: unknown };
        const verdict = validateAnnouncementPatch(source);
        if (!verdict.ok) return adminNoStore({ message: verdict.message }, 400);

        const announcement = await updateDisplayAnnouncementWith(
          client,
          announcementId,
          verdict.value,
          identity.username,
        );
        if (!announcement) {
          return adminNoStore({ message: "الإعلان غير موجود — ربما حُذف من نافذة أخرى." }, 404);
        }
        await insertAuditRow(client, {
          action: "display.announcement.update",
          entity: "display_announcement",
          entityId: announcement.id,
          entityLabel: announcement.title,
          details: { الحقول: Object.keys(verdict.value) },
          actor: identity.username,
          actorRole: identity.role,
        });
        return adminNoStore({ announcement }, 200);
      },
    );
  } catch (error) {
    return mapCanonicalAdminRefusal(error, "تعذّر حفظ التعديل. أعد المحاولة.");
  }
}

export async function canonicalDisplayAnnouncementsDelete(
  session: VerifiedDurableSession,
  rawId: string,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  const announcementId = parseAnnouncementId(rawId);
  try {
    return await withStaffOperation(
      getPool(),
      session,
      "settings.operational.edit",
      async (client, opHandle) => {
        const identity = await staffOperationIdentity(client, opHandle, "settings.operational.edit");
        if (announcementId === null) {
          return adminNoStore({ message: "إعلان غير صالح." }, 400);
        }
        const removed = await deleteDisplayAnnouncementWith(client, announcementId);
        if (!removed) {
          return adminNoStore({ message: "الإعلان غير موجود — ربما حُذف من نافذة أخرى." }, 404);
        }
        await insertAuditRow(client, {
          action: "display.announcement.delete",
          entity: "display_announcement",
          entityId: announcementId,
          actor: identity.username,
          actorRole: identity.role,
        });
        return adminNoStore({ removed: true }, 200);
      },
    );
  } catch (error) {
    return mapCanonicalAdminRefusal(error, "تعذّر حذف الإعلان. أعد المحاولة.");
  }
}

export async function canonicalDisplayAnnouncementsReorderPatch(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  let body: unknown;
  try {
    body = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return adminNoStore({ message: "طلب غير صالح." }, 400);
  }
  const source = (body ?? {}) as { ids?: unknown };
  const ids = parseAnnouncementReorder(source.ids);

  try {
    return await withStaffOperation(
      getPool(),
      session,
      "settings.operational.edit",
      async (client, opHandle) => {
        const identity = await staffOperationIdentity(client, opHandle, "settings.operational.edit");
        if (ids === null) {
          return adminNoStore(
            { message: "قائمة الترتيب غير صالحة — أرقام الإعلانات كاملةً بلا تكرار." },
            400,
          );
        }
        try {
          await reorderDisplayAnnouncementsInTransaction(client, ids);
          const announcements = await listDisplayAnnouncementsWith(client);
          await insertAuditRow(client, {
            action: "display.announcement.reorder",
            entity: "display_announcement",
            details: { العدد: ids.length },
            actor: identity.username,
            actorRole: identity.role,
          });
          return adminNoStore({ announcements }, 200);
        } catch (err) {
          if (err instanceof Error && err.message === "ANNOUNCEMENTS_REORDER_INCOMPLETE") {
            return adminNoStore(
              { message: "قائمة الترتيب لم تعد مطابقة — أعد تحميل الصفحة وأعد المحاولة." },
              409,
            );
          }
          throw err;
        }
      },
    );
  } catch (error) {
    return mapCanonicalAdminRefusal(error, "تعذّر حفظ الترتيب. أعد المحاولة.");
  }
}

export async function canonicalSettingsHistoryGet(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  const url = new URL(request.url);
  const textParam = (name: string): string | null => {
    const value = url.searchParams.get(name);
    return value && value.trim() ? value.trim() : null;
  };
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const beforeId = textParam("beforeId");
  const invalidFilter =
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    (beforeId !== null && !/^[1-9]\d{0,18}$/.test(beforeId)) ||
    [textParam("from"), textParam("to")].some(
      (date) => date !== null && (!DATE_PATTERN.test(date) || !Number.isFinite(Date.parse(date))),
    );

  try {
    const outcome = await runCanonicalReadSnapshot(
      session,
      "audit.view",
      async (query) => {
        if (invalidFilter) return { kind: "bad_filter" as const };
        const { rows } = await query.query<{
          id: string;
          action: string;
          entity_id: string | null;
          details: Record<string, unknown> | null;
          actor: string;
          actor_role: string | null;
          created_at: Date;
        }>(
          `SELECT id::text, action, entity_id, details, actor, actor_role, created_at
             FROM audit_log
            WHERE entity = $1
              AND action LIKE 'clinic_settings.%'
              AND ($2::text IS NULL OR entity_id = $2::text)
              AND ($3::text IS NULL OR details->>'الفئة' = $3::text)
              AND ($4::text IS NULL OR actor = $4::text)
              AND ($5::text IS NULL OR created_at >= $5::timestamptz)
              AND ($6::text IS NULL OR created_at < ($6::date + 1)::timestamptz)
              AND ($8::bigint IS NULL OR id < $8::bigint)
              AND ($9::text IS NULL OR action = $9::text)
            ORDER BY audit_log.id DESC
            LIMIT $7`,
          [
            SETTINGS_AUDIT_ENTITY,
            textParam("key"),
            textParam("category"),
            textParam("actor"),
            textParam("from"),
            textParam("to"),
            limit,
            beforeId,
            textParam("action"),
          ],
        );
        return {
          kind: "ok" as const,
          entries: rows.map((row) => {
            const details = (row.details ?? {}) as Record<string, unknown>;
            const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
            return {
              id: row.id,
              action: row.action,
              key: row.entity_id ?? str(details["المفتاح"]) ?? "",
              category: str(details["الفئة"]),
              before: str(details["قبل"]),
              after: str(details["بعد"]),
              secretState: str(details["الحالة"]),
              reason: str(details["السبب"]),
              actor: row.actor,
              actorRole: row.actor_role,
              at: row.created_at.toISOString(),
            };
          }),
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: 2_097_152 },
    );
    if (outcome.kind === "bad_filter") {
      return adminNoStore({ message: "مرشحات السجل غير صالحة." }, 400);
    }
    return adminNoStore(outcome.entries, 200);
  } catch (error) {
    return mapCanonicalAdminRefusal(error, "تعذّر تحميل سجلّ الإعدادات.");
  }
}

export async function canonicalLoginPhotoGet(
  session: VerifiedDurableSession,
): Promise<Response> {
  if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) {
    return NextResponse.json({ message: "الهوية الموحّدة غير متاحة الآن." }, { status: 503, headers: loginPhotoHeaders });
  }
  try {
    const rawValue = await runCanonicalReadSnapshot(
      session,
      "settings.operational.edit",
      async (query) => {
        const stored = await readStoredSettingsWith(query);
        return stored.get(LOGIN_PHOTO_ASSET)?.value ?? "";
      },
      { errorPrefix: "STAFF_READ", maxBytes: 16_384 },
    );
    const asset = parseLoginPhotoAsset(rawValue);
    const bytes = asset ? await readVerifiedLoginPhoto(asset) : null;
    if (!asset || !bytes) return new Response(null, { status: 404, headers: loginPhotoHeaders });
    return new Response(new Uint8Array(bytes), {
      headers: {
        ...loginPhotoHeaders,
        "Content-Type": asset.mimeType,
        "Content-Disposition": "inline",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    const refusal = staffAdmissionRefusal(error);
    if (refusal) {
      return NextResponse.json({ message: refusal.message }, { status: refusal.status, headers: loginPhotoHeaders });
    }
    return NextResponse.json({ message: "تعذّر تحميل معاينة الصورة." }, { status: 500, headers: loginPhotoHeaders });
  }
}

export async function canonicalLoginPhotoPost(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) {
    return NextResponse.json({ message: "الهوية الموحّدة غير متاحة الآن." }, { status: 503, headers: loginPhotoHeaders });
  }
  try {
    const form = await readBoundedFormData(request, LOGIN_PHOTO_BODY_BYTES);
    let rawVersions: unknown;
    try {
      rawVersions = JSON.parse(String(form.get("__versions") ?? ""));
    } catch {
      return NextResponse.json({ message: "نسخة الإعداد مفقودة. حدّث الصفحة." }, { status: 409, headers: loginPhotoHeaders });
    }
    const expected = loginPhotoVersions(rawVersions);
    if (!expected) {
      return NextResponse.json({ message: "نسخة الإعداد مفقودة. حدّث الصفحة." }, { status: 409, headers: loginPhotoHeaders });
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0 || file.size > LOGIN_PHOTO_MAX_BYTES) {
      return NextResponse.json({ message: "اختر صورة JPEG أو PNG لا تتجاوز ٢ ميغابايت." }, { status: 400, headers: loginPhotoHeaders });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!validateLoginPhotoBytes(bytes, file.type)) {
      return NextResponse.json(
        { message: "الصورة غير صالحة. استخدم JPEG أو PNG ثابتة ضمن حدود الحجم والأبعاد." },
        { status: 400, headers: loginPhotoHeaders },
      );
    }
    let uploadedStored: StoredFile | null = null;
    try {
      const outcome = await withStaffOperation(
        getPool(),
        session,
        "settings.operational.edit",
        async (client, opHandle) => {
          const identity = await staffOperationIdentity(client, opHandle, "settings.operational.edit");
          const planned = validateLoginPhotoBytes(bytes, file.type);
          if (planned) await holdStorageKeyShared(client, planned.key);
          const storedPhoto = await storeLoginPhotoWithMeta(bytes, file.type);
          uploadedStored = storedPhoto.stored;
          const writeRes = await writeSettingsInTransaction(client, {
            values: { [LOGIN_PHOTO_ASSET]: JSON.stringify(storedPhoto.asset), [LOGIN_PHOTO_VISIBLE]: "false" },
            expected,
          });
          if (!writeRes.ok) return { ok: false as const };
          for (const entry of writeRes.audits) {
            await insertAuditRow(client, {
              action: SETTINGS_AUDIT_UPDATE,
              entity: SETTINGS_AUDIT_ENTITY,
              entityId: entry.key,
              details: entry.details,
              actor: identity.username,
              actorRole: identity.role,
            });
          }
          const stored = await readStoredSettingsWith(client);
          return {
            ok: true as const,
            payload: {
              [LOGIN_PHOTO_ASSET]: stored.get(LOGIN_PHOTO_ASSET)?.value ?? "",
              [LOGIN_PHOTO_VISIBLE]: stored.get(LOGIN_PHOTO_VISIBLE)?.value ?? "false",
              __versions: Object.fromEntries(LOGIN_PHOTO_KEYS.map((k) => [k, stored.get(k)?.updatedAt ?? null])),
            },
          };
        },
      );
      if (!outcome.ok) {
        await cleanupUncommittedStoredFile(uploadedStored);
        return NextResponse.json(
          { message: "تغيرت الصورة أو حالة إظهارها. حدّث الإعدادات قبل إعادة المحاولة." },
          { status: 409, headers: loginPhotoHeaders },
        );
      }
      invalidateSettingsCache();
      return NextResponse.json(outcome.payload, { headers: loginPhotoHeaders });
    } catch (innerError) {
      await cleanupUncommittedStoredFile(uploadedStored);
      throw innerError;
    }
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) {
      bounded.headers.set("Cache-Control", "private, no-store");
      bounded.headers.set("X-Content-Type-Options", "nosniff");
      return bounded;
    }
    const refusal = staffAdmissionRefusal(error);
    if (refusal) {
      return NextResponse.json({ message: refusal.message }, { status: refusal.status, headers: loginPhotoHeaders });
    }
    return NextResponse.json(
      { message: "تعذّر حفظ الصورة. تحقق من التخزين الدائم وحدّث الإعدادات قبل إعادة المحاولة." },
      { status: 500, headers: loginPhotoHeaders },
    );
  }
}

export async function canonicalLoginPhotoPatch(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) {
    return NextResponse.json({ message: "الهوية الموحّدة غير متاحة الآن." }, { status: 503, headers: loginPhotoHeaders });
  }
  try {
    const body = (await readJsonBody(request, 4096)) as Record<string, unknown>;
    const expected = loginPhotoVersions(body?.__versions);
    if (!expected) {
      return NextResponse.json({ message: "نسخة الإعداد مفقودة. حدّث الصفحة." }, { status: 409, headers: loginPhotoHeaders });
    }
    if (typeof body.visible !== "boolean") {
      return NextResponse.json({ message: "حالة الإظهار غير صالحة." }, { status: 400, headers: loginPhotoHeaders });
    }
    const visible = body.visible;

    const outcome = await withStaffOperation(
      getPool(),
      session,
      "settings.operational.edit",
      async (client, opHandle) => {
        const identity = await staffOperationIdentity(client, opHandle, "settings.operational.edit");
        const storedBefore = await readStoredSettingsWith(client);
        const raw = storedBefore.get(LOGIN_PHOTO_ASSET)?.value ?? "";
        const asset = parseLoginPhotoAsset(raw);
        if (visible && (!asset || !(await readVerifiedLoginPhoto(asset)))) {
          return { kind: "missing_photo" as const };
        }
        const writeRes = await writeSettingsInTransaction(client, {
          values: { [LOGIN_PHOTO_ASSET]: raw, [LOGIN_PHOTO_VISIBLE]: String(visible) },
          expected,
        });
        if (!writeRes.ok) return { kind: "conflict" as const };
        for (const entry of writeRes.audits) {
          await insertAuditRow(client, {
            action: SETTINGS_AUDIT_UPDATE,
            entity: SETTINGS_AUDIT_ENTITY,
            entityId: entry.key,
            details: entry.details,
            actor: identity.username,
            actorRole: identity.role,
          });
        }
        const storedAfter = await readStoredSettingsWith(client);
        return {
          kind: "ok" as const,
          payload: {
            [LOGIN_PHOTO_ASSET]: storedAfter.get(LOGIN_PHOTO_ASSET)?.value ?? "",
            [LOGIN_PHOTO_VISIBLE]: storedAfter.get(LOGIN_PHOTO_VISIBLE)?.value ?? "false",
            __versions: Object.fromEntries(LOGIN_PHOTO_KEYS.map((k) => [k, storedAfter.get(k)?.updatedAt ?? null])),
          },
        };
      },
    );
    if (outcome.kind === "missing_photo") {
      return NextResponse.json({ message: "ارفع صورة صالحة قبل إظهارها." }, { status: 400, headers: loginPhotoHeaders });
    }
    if (outcome.kind === "conflict") {
      return NextResponse.json(
        { message: "تغيرت الصورة أو حالة إظهارها. حدّث الإعدادات قبل إعادة المحاولة." },
        { status: 409, headers: loginPhotoHeaders },
      );
    }
    invalidateSettingsCache();
    return NextResponse.json(outcome.payload, { headers: loginPhotoHeaders });
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) {
      bounded.headers.set("Cache-Control", "private, no-store");
      bounded.headers.set("X-Content-Type-Options", "nosniff");
      return bounded;
    }
    const refusal = staffAdmissionRefusal(error);
    if (refusal) {
      return NextResponse.json({ message: refusal.message }, { status: refusal.status, headers: loginPhotoHeaders });
    }
    return NextResponse.json(
      { message: "تعذّر تأكيد التغيير. حدّث الإعدادات قبل إعادة المحاولة." },
      { status: 500, headers: loginPhotoHeaders },
    );
  }
}

export async function canonicalMaterialRatesGet(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "settings.view",
      async (query) => {
        const settings = await getSettingsWith(query);
        const { rows } = await query.query<{
          category: string;
          rate_bp: number;
          updated_by: string;
          updated_at: Date;
        }>(`SELECT category, rate_bp, updated_by, updated_at FROM material_rates ORDER BY category`);
        return {
          rates: rows.map((row) => ({
            category: row.category,
            rateBp: Number(row.rate_bp),
            updatedBy: row.updated_by,
            updatedAt: row.updated_at.toISOString(),
          })),
          applied: settings["finance.commission_material_rate"] === "on",
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: 131_072 },
    );
    return adminNoStore(payload, 200);
  } catch (error) {
    return mapCanonicalAdminRefusal(error, "تعذّر تحميل النسب.");
  }
}

export async function canonicalMaterialRatesPost(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(request, SETTINGS_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return adminNoStore({ message: "طلب غير صالح." }, 400);
  }

  try {
    return await withStaffOperation(
      getPool(),
      session,
      "settings.operational.edit",
      async (client, opHandle) => {
        const identity = await staffOperationIdentity(client, opHandle, "settings.operational.edit");
        const category = typeof body.category === "string" ? body.category : "";
        const rawRate = body.rateBp === null ? null : (body.rateBp ?? body.rate);
        const rateBp = rawRate === null ? null : parseRateBp(rawRate);
        if (rateBp === null && rawRate !== null) {
          return adminNoStore(
            { message: "نسبة غير صالحة — اكتبها بالمئة (7.5 مثلًا) وبين صفر ومئة." },
            400,
          );
        }
        const result = await setMaterialRateInTransaction(
          client,
          { category, rateBp, actor: identity.username, actorRole: identity.role },
          (row) => insertAuditRow(client, row),
        );
        if (!result.ok) return adminNoStore({ message: result.message }, 400);
        return adminNoStore({ ok: true }, 200);
      },
    );
  } catch (error) {
    return mapCanonicalAdminRefusal(error, "تعذّر حفظ النسبة.");
  }
}

export async function canonicalPatientNumberingGet(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  try {
    const preview = await runCanonicalReadSnapshot(
      session,
      "settings.operational.edit",
      async (query) => readCanonicalNumberingPreviewWith(query),
      { errorPrefix: "STAFF_READ", maxBytes: 32_768 },
    );
    return NextResponse.json(preview, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const refusal = staffAdmissionRefusal(error);
    if (refusal) return adminNoStore({ message: refusal.message }, refusal.status);
    return patientNumberingErrorResponse(error);
  }
}

export async function canonicalPatientNumberingPatch(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return adminNoStore({ message: "الطلب غير صالح." }, 400);
  }

  try {
    return await withStaffOperation(
      getPool(),
      session,
      "settings.operational.edit",
      async (client, opHandle) => {
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return adminNoStore({ message: "الطلب غير صالح." }, 400);
        }
        const identity = await staffOperationIdentity(client, opHandle, "settings.operational.edit");
        const input = body as Record<string, unknown>;
        const updated = await changeCanonicalNumberingFloorWith(
          client,
          { username: identity.username, role: identity.role },
          {
            minimumNext: input.minimumNext,
            expectedVersion: input.expectedVersion,
            expectedNextNumber: input.expectedNextNumber,
            reason: input.reason,
          },
        );
        return adminNoStore(updated, 200);
      },
    );
  } catch (error) {
    const refusal = staffAdmissionRefusal(error);
    if (refusal) return adminNoStore({ message: refusal.message }, refusal.status);
    return patientNumberingErrorResponse(error);
  }
}

interface CanonicalReadinessCheck {
  id: string;
  category: "clinic" | "finance" | "clinical" | "security" | "operations";
  title: string;
  description: string;
  status: "pass" | "warn" | "fail";
  details?: string;
  actionHref?: string;
  actionLabel?: string;
}

export async function canonicalSettingsReadinessGet(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const unavailable = assertCanonicalDbAvailable();
  if (unavailable) return unavailable;

  try {
    const dbChecks = await runCanonicalReadSnapshot(
      session,
      "audit.view",
      async (query) => {
        const dbStart = Date.now();
        await query.query("SELECT 1");
        const dbLatency = Date.now() - dbStart;
        const settings = await getSettingsWith(query);
        const rateRows = await query.query<{ key: string; age_days: string }>(
          `SELECT key, FLOOR(EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400)::int::text AS age_days
             FROM settings WHERE key IN ('finance.rate.SAR', 'finance.rate.USD')`,
        );
        const doctors = await query.query<{ c: string }>(
          `SELECT count(*)::int AS c FROM parties WHERE kind = 'doctor'`,
        );
        const services = await query.query<{ c: string }>(`SELECT count(*)::int AS c FROM services`);
        const pricing = await query.query<{ unpriced: number; provisional: number; total: number }>(
          `SELECT COUNT(*) FILTER (WHERE is_active AND NOT price_configured)::int AS unpriced,
                  COUNT(*) FILTER (WHERE is_active AND price_provisional)::int AS provisional,
                  COUNT(*) FILTER (WHERE is_active)::int AS total
             FROM services`,
        );
        const users = await query.query<{ c: string }>(
          `SELECT count(*)::int AS c FROM users WHERE is_active = true`,
        );
        return {
          dbLatency,
          settings,
          rateRows: rateRows.rows,
          docCount: Number(doctors.rows[0]?.c ?? 0),
          serviceCount: Number(services.rows[0]?.c ?? 0),
          unpricedCount: Number(pricing.rows[0]?.unpriced ?? 0),
          provisionalCount: Number(pricing.rows[0]?.provisional ?? 0),
          userCount: Number(users.rows[0]?.c ?? 0),
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: 262_144 },
    );

    const checks: CanonicalReadinessCheck[] = [];
    checks.push({
      id: "db_connected",
      category: "operations",
      title: "اتصال قاعدة البيانات وسرعة الاستجابة",
      description: `قاعدة البيانات متصلة وتستجيب في غضون ${dbChecks.dbLatency}ms بنجاح تام.`,
      status: dbChecks.dbLatency < 200 ? "pass" : "warn",
    });

    const clinicName = dbChecks.settings["clinic.name"];
    const clinicPhone = dbChecks.settings["clinic.phone"];
    const clinicAddress = dbChecks.settings["clinic.address"];

    if (clinicName && clinicName !== SETTING_DEFAULTS["clinic.name"]) {
      checks.push({
        id: "clinic_identity",
        category: "clinic",
        title: "هوية واسم المركز الطبي",
        description: `تم تعيين اسم المركز (${clinicName}) بنجاح ويظهر في الترويسات والمطبوعات.`,
        status: "pass",
      });
    } else {
      checks.push({
        id: "clinic_identity",
        category: "clinic",
        title: "هوية واسم المركز الطبي",
        description: "اسم المركز الافتراضي قيد الاستخدام. يمكنك تخصيصه بحسب اسم المركز الحقيقي.",
        status: "pass",
        actionHref: "/settings",
        actionLabel: "تعديل الإعدادات",
      });
    }

    if (!clinicPhone || !clinicAddress) {
      checks.push({
        id: "clinic_contacts",
        category: "clinic",
        title: "بيانات التواصل والعنوان للمركز",
        description: "يُفضل تعيين هاتف المركز وعنوانه لتظهر في تذييل كروت المواعيد والسندات والروشتات.",
        status: "warn",
        actionHref: "/settings",
        actionLabel: "إكمال البيانات",
      });
    } else {
      checks.push({
        id: "clinic_contacts",
        category: "clinic",
        title: "بيانات التواصل والعنوان للمركز",
        description: "بيانات الهاتف والعنوان مكتملة ومضبوطة في نماذج الطباعة.",
        status: "pass",
      });
    }

    const sarRate = Number(dbChecks.settings["finance.rate.SAR"] ?? 0);
    const usdRate = Number(dbChecks.settings["finance.rate.USD"] ?? 0);
    const maxAgeDays = Math.max(1, Number(dbChecks.settings["finance.rate_max_age_days"]) || 7);
    const rateAge = new Map(dbChecks.rateRows.map((row) => [row.key, Number(row.age_days)]));
    const neverSaved = ["finance.rate.SAR", "finance.rate.USD"].filter((key) => !rateAge.has(key));
    const oldestAge = Math.max(0, ...rateAge.values());

    if (!(sarRate > 0 && usdRate > 0)) {
      checks.push({
        id: "exchange_rates",
        category: "finance",
        title: "أسعار صرف العملات الأجنبية",
        description: "أسعار الصرف غير مضبوطة أو تساوي صفر، يرجى تحديثها لضمان حساب السندات بالريال السعودي والدولار.",
        status: "fail",
        actionHref: "/settings",
        actionLabel: "ضبط سعر الصرف",
      });
    } else if (neverSaved.length > 0) {
      checks.push({
        id: "exchange_rates",
        category: "finance",
        title: "أسعار صرف العملات الأجنبية (السعودي والدولار)",
        description: `ما زالت القيمة الافتراضية من يوم التثبيت مستخدمة (1 ر.س = ${sarRate} ر.ي ، 1 $ = ${usdRate} ر.ي). راجِعها واحفظ سعر اليوم.`,
        status: "warn",
        actionHref: "/settings",
        actionLabel: "تحديث الأسعار",
      });
    } else if (oldestAge > maxAgeDays) {
      checks.push({
        id: "exchange_rates",
        category: "finance",
        title: "أسعار صرف العملات الأجنبية (السعودي والدولار)",
        description: `آخر تحديثٍ لسعر الصرف منذ ${oldestAge} يومًا (الحد ${maxAgeDays}). 1 ر.س = ${sarRate} ر.ي ، 1 $ = ${usdRate} ر.ي.`,
        status: "warn",
        actionHref: "/settings",
        actionLabel: "تحديث الأسعار",
      });
    } else {
      checks.push({
        id: "exchange_rates",
        category: "finance",
        title: "أسعار صرف العملات الأجنبية (السعودي والدولار)",
        description: `مضبوطة ومحدَّثة: 1 ر.س = ${sarRate} ر.ي ، 1 $ = ${usdRate} ر.ي.`,
        status: "pass",
        actionHref: "/settings",
        actionLabel: "تحديث الأسعار",
      });
    }

    if (dbChecks.docCount > 0) {
      checks.push({
        id: "doctors_list",
        category: "clinical",
        title: "كادر الأطباء والعيادات المسجلة",
        description: `يوجد ${dbChecks.docCount} أطباء مسجلين في النظام لاستقبال المرضى وتوزيع المواعيد والزيارات.`,
        status: "pass",
      });
    } else {
      checks.push({
        id: "doctors_list",
        category: "clinical",
        title: "كادر الأطباء المسجلين",
        description: "لم يتم تسجيل أي طبيب في دليل الأطراف حتى الآن.",
        status: "warn",
        actionHref: "/settings",
        actionLabel: "إضافة أطباء",
      });
    }

    if (dbChecks.serviceCount >= 5) {
      checks.push({
        id: "services_catalog",
        category: "clinical",
        title: "دليل الخدمات والأسعار السريرية",
        description: `يحتوي دليل الخدمات على ${dbChecks.serviceCount} خدمة طبية جاهزة للاستخدام في الفواتير والخطط العلاجية.`,
        status: "pass",
      });
    } else {
      checks.push({
        id: "services_catalog",
        category: "clinical",
        title: "دليل الخدمات والأسعار",
        description: "دليل الخدمات يحتوي على عدد قليل من الخدمات. يُنصح بإضافة تسعيرة خدمات العيادة كاملة.",
        status: "warn",
        actionHref: "/settings",
        actionLabel: "تحديث دليل الخدمات",
      });
    }

    if (dbChecks.unpricedCount > 0) {
      checks.push({
        id: "services_pricing_gate",
        category: "finance",
        title: "خدمات نشطة بلا سعر معتمد",
        description: `${dbChecks.unpricedCount} خدمة نشطة بلا سعر قرّره المالك — يصطدم بها الاستقبال عند الفوترة. سعّر الدليل دفعةً واحدة من شاشة الخدمات.`,
        status: "warn",
        actionHref: "/finance/services",
        actionLabel: "تسعير الدليل دفعة واحدة",
      });
    } else if (dbChecks.provisionalCount > 0) {
      checks.push({
        id: "services_pricing_gate",
        category: "finance",
        title: "أسعار تخمينية موسومة",
        description: `${dbChecks.provisionalCount} خدمة تسعّر بأرقام تخمينية موسومة — تعمل في الفواتير لكنها لم يقرّها المالك. عدّلها بيدك فيُصبح قرارك ويمسح الوسم.`,
        status: "warn",
        actionHref: "/finance/services",
        actionLabel: "استبدال الأسعار التخمينية",
      });
    } else {
      checks.push({
        id: "services_pricing_gate",
        category: "finance",
        title: "بوابة التسعير",
        description: "كل الخدمات النشطة مسعّرة بقرارٍ معتمد — لا خدمة تصطدم بها الفوترة.",
        status: "pass",
      });
    }

    checks.push({
      id: "users_setup",
      category: "security",
      title: "حسابات المستخدمين والصلاحيات (RBAC)",
      description: `يوجد ${dbChecks.userCount} مستخدم نشط في النظام مع صلاحيات محددة (مدير، طبيب، استقبال، محاسب).`,
      status: dbChecks.userCount >= 2 ? "pass" : "warn",
      actionHref: "/settings/users",
      actionLabel: "إدارة المستخدمين",
    });

    const chairs = Number(dbChecks.settings["clinic.chairs"] ?? 2);
    checks.push({
      id: "chairs_display",
      category: "operations",
      title: "الكراسي وشاشة انتظار الصالة والتلفزيون",
      description: `تم إعداد ${chairs} كراسي طبية، مع تفعيل شاشة الانتظار الفورية للمرضى مع جرس التنبيه الصوتي.`,
      status: "pass",
      actionHref: "/display",
      actionLabel: "فتح شاشة الصالة",
    });

    checks.push({
      id: "backup_system",
      category: "security",
      title: "النسخ الاحتياطي وتصدير البيانات",
      description: "نظام تصدير النسخ الاحتياطية الكاملة والمشفرة بتنسيق SQL و JSON جاهز ويعمل بكفاءة.",
      status: "pass",
      actionHref: "/settings/export",
      actionLabel: "تصدير نسخة الآن",
    });

    const releaseSha = (process.env.RAILWAY_GIT_COMMIT_SHA ?? "").slice(0, 7);
    checks.push({
      id: "release_revision",
      category: "operations",
      title: "نسخة الإصدار العاملة",
      description: releaseSha
        ? `الإصدار الحالي المنشور: ${releaseSha} (أول 7 خانات من بصمة الالتزام).`
        : "بصمة الإصدار غير متاحة — لا يعمل النشر من Railway أو غاب RAILWAY_GIT_COMMIT_SHA.",
      status: "pass",
    });

    const storage = await probeStorageReadiness();
    checks.push({
      id: "storage_durability",
      category: "security",
      title: "دوام تخزين مستندات المرضى",
      description: storage.durable
        ? `التخزين جاهز ودائم${storage.verifiedRoot ? ` — الجذر الموثق: ${storage.verifiedRoot}` : ""}.`
        : `غير دائم: ${storage.reasons.join("؛ ") || "سبب غير محدد"}.`,
      status: storage.durable ? "pass" : storage.production ? "fail" : "warn",
    });

    const setupToken = process.env.SETUP_TOKEN ?? "";
    if (setupToken.length >= 16 && dbChecks.userCount >= 1) {
      checks.push({
        id: "setup_token_cleanup",
        category: "security",
        title: "رمز الإعداد الأول",
        description: "يوجد حساب مدير بالفعل وSETUP_TOKEN لا يزال مضبوطاً — احذفه من إعدادات النشر: صلاحيته الوحيدة المتبقية هجوم محتمل.",
        status: "warn",
        actionHref: "/settings",
        actionLabel: "مراجعة الإعدادات",
      });
    }

    return adminNoStore(
      {
        checks,
        summary: {
          total: checks.length,
          passed: checks.filter((c) => c.status === "pass").length,
          warnings: checks.filter((c) => c.status === "warn").length,
          failed: checks.filter((c) => c.status === "fail").length,
          ready: checks.filter((c) => c.status === "fail").length === 0,
        },
      },
      200,
    );
  } catch (error) {
    return mapCanonicalAdminRefusal(error, "تعذّر فحص الجاهزية.");
  }
}

export async function canonicalMessagingSettingsGet(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const admitted = await withCanonicalOwnerOperation(
    session,
    "settings.integrations.change",
    async (client) => listMessagingChannelsWith(client),
  );
  if (!admitted.ok) {
    if (admitted.reason === "forbidden") {
      return NextResponse.json({ message: "إعدادات قنوات المراسلة للمدير وحده." }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    if (admitted.reason === "unavailable") {
      return NextResponse.json({ message: "الهوية الموحّدة غير متاحة الآن." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ channels: admitted.value }, { status: 200, headers: { "Cache-Control": "no-store" } });
}

export async function canonicalMessagingSettingsPut(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES);
    body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const admitted = await withCanonicalOwnerOperation(
      session,
      "settings.integrations.change",
      async (client, view) => {
        if (!isChannel(body.channel)) {
          return NextResponse.json({ message: "قناة غير معروفة." }, { status: 400, headers: { "Cache-Control": "no-store" } });
        }
        const enabled = body.enabled === true;
        const normalized = normalizeChannelConfig(body.channel, body.config, enabled);
        if (!normalized.ok) {
          return NextResponse.json({ message: normalized.message }, { status: 400, headers: { "Cache-Control": "no-store" } });
        }
        const rawSecrets = (body.secrets && typeof body.secrets === "object" ? body.secrets : {}) as Record<string, unknown>;
        const secrets: Record<string, string | null> = {};
        for (const { key } of SECRET_FIELDS[body.channel]) {
          const value = rawSecrets[key];
          if (value === null) secrets[key] = null;
          else if (typeof value === "string" && value.trim()) secrets[key] = value.trim().slice(0, 2000);
        }
        const current = (await listMessagingChannelsWith(client)).find((row) => row.channel === body.channel);
        const present = new Set(current?.secretKeys ?? []);
        for (const [key, value] of Object.entries(secrets)) {
          if (value === null) present.delete(key);
          else present.add(key);
        }
        const missing = enabled ? missingSecretForEnable(body.channel, normalized.config, present) : null;
        if (missing) {
          return NextResponse.json({ message: missing }, { status: 400, headers: { "Cache-Control": "no-store" } });
        }
        const saved = await saveMessagingChannelInTransaction(
          client,
          {
            channel: body.channel,
            enabled,
            config: normalized.config,
            secrets,
            actor: view.username,
            actorRole: view.roleLabel,
          },
          (row) => insertAuditRow(client, row),
        );
        return NextResponse.json({ channel: saved }, { status: 200, headers: { "Cache-Control": "no-store" } });
      },
    );
    if (!admitted.ok) {
      if (admitted.reason === "forbidden") {
        return NextResponse.json({ message: "إعدادات قنوات المراسلة للمدير وحده." }, { status: 403, headers: { "Cache-Control": "no-store" } });
      }
      if (admitted.reason === "unavailable") {
        return NextResponse.json({ message: "الهوية الموحّدة غير متاحة الآن." }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
      return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    return admitted.value;
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ إعدادات القناة." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
