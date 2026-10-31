import "server-only";
import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "./security-limits";
import { bodyErrorResponse, readJsonBody } from "./http-body";
import { getPool, usesSharedLocalDatabaseConnection } from "./db";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { canCanonicalAccessUnifiedReport, isKnownUnifiedReport, type UnifiedReportId } from "./report-access";
import { templatesForCanonical } from "./report-templates";
import {
  SavedReportInputError,
  availableCopyNameWith,
  createSavedReportWith,
  deleteSavedReportWith,
  getVisibleSavedReportWith,
  listSavedReportsWith,
  normalizeReportSection,
  normalizeSavedReportName,
  normalizeSavedReportQuery,
  updateSavedReportWith,
  type ReportSectionId,
} from "./saved-reports";
import { STAFF_CAPABILITIES } from "./staff-capability-catalogue";
import { staffAdmissionRefusal } from "./staff-capability-editor";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationCapabilities,
  staffOperationIdentity,
  staffOperationOwnerOperations,
  withStaffOperation,
} from "./staff-operation-runtime";

const savedReportsJson = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

function parseSavedReportPositiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function mapSavedReportsRefusal(error: unknown, fallbackMessage: string): NextResponse {
  if (error instanceof SavedReportInputError) {
    return savedReportsJson({ message: error.message }, 400);
  }
  const refusal = staffAdmissionRefusal(error);
  if (refusal) {
    return savedReportsJson({ message: refusal.message }, refusal.status);
  }
  return savedReportsJson({ message: fallbackMessage }, 500);
}

export async function canonicalSavedReportsGet(session: VerifiedDurableSession): Promise<NextResponse> {
  if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) {
    return savedReportsJson({ message: "الهوية الموحّدة غير متاحة الآن." }, 503);
  }
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "reports.operational.view",
      async (query, scope) => {
        const saved = await listSavedReportsWith(query, scope.username);
        const granted = (cap: (typeof STAFF_CAPABILITIES)[number]) => scope.granted(cap);
        return {
          saved: saved.filter((item) => canCanonicalAccessUnifiedReport(item.reportId, granted)),
          templates: templatesForCanonical(granted),
          canShare: scope.ownerMay("settings.security.change"),
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: 1_048_576 },
    );
    return savedReportsJson(payload, 200);
  } catch (error) {
    return mapSavedReportsRefusal(error, "تعذّر تحميل التقارير المحفوظة.");
  }
}

export async function canonicalSavedReportsPost(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) {
    return savedReportsJson({ message: "الهوية الموحّدة غير متاحة الآن." }, 503);
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return savedReportsJson({ message: "طلب غير صالح." }, 400);
  }

  try {
    return await withStaffOperation(getPool(), session, "reports.operational.view", async (client, opHandle) => {
      const identity = await staffOperationIdentity(client, opHandle, "reports.operational.view");
      const caps = await staffOperationCapabilities(client, opHandle, "reports.operational.view", STAFF_CAPABILITIES);
      const ownerOps = await staffOperationOwnerOperations(client, opHandle, "reports.operational.view", ["settings.security.change"]);
      const granted = (cap: (typeof STAFF_CAPABILITIES)[number]) => caps.has(cap);
      const isOwner = ownerOps.has("settings.security.change");

      if (body.duplicateOf !== undefined) {
        const sourceId = parseSavedReportPositiveId(body.duplicateOf);
        if (!sourceId) return savedReportsJson({ message: "معرّف التقرير غير صالح." }, 400);
        const source = await getVisibleSavedReportWith(client, identity.username, sourceId);
        if (!source || !canCanonicalAccessUnifiedReport(source.reportId, granted)) {
          return savedReportsJson({ message: "التقرير المحفوظ غير موجود." }, 404);
        }
        const name = body.name === undefined
          ? await availableCopyNameWith(client, identity.username, source.name)
          : normalizeSavedReportName(body.name);
        const saved = await createSavedReportWith(client, {
          ownerUsername: identity.username,
          name,
          reportId: source.reportId,
          sectionId: source.sectionId,
          queryString: source.queryString,
        });
        return savedReportsJson({ saved }, 201);
      }

      const name = normalizeSavedReportName(body.name);
      const sectionId = normalizeReportSection(body.sectionId);
      const normalized = normalizeSavedReportQuery(body.reportId, body.queryString);
      if (!isKnownUnifiedReport(normalized.reportId)
          || !canCanonicalAccessUnifiedReport(normalized.reportId, granted)) {
        return savedReportsJson({ message: "ليس لديك صلاحية حفظ هذا التقرير." }, 403);
      }
      if (body.isShared === true && !isOwner) {
        return savedReportsJson({ message: "مشاركة التقارير مع الطاقم للمدير فقط." }, 403);
      }
      const saved = await createSavedReportWith(client, {
        ownerUsername: identity.username,
        name,
        reportId: normalized.reportId,
        sectionId,
        queryString: normalized.queryString,
        isFavorite: body.isFavorite === true,
        isShared: body.isShared === true,
      });
      return savedReportsJson({ saved }, 201);
    });
  } catch (error) {
    return mapSavedReportsRefusal(error, "تعذّر حفظ التقرير.");
  }
}

export async function canonicalSavedReportsPatch(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) {
    return savedReportsJson({ message: "الهوية الموحّدة غير متاحة الآن." }, 503);
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return savedReportsJson({ message: "طلب غير صالح." }, 400);
  }

  try {
    return await withStaffOperation(getPool(), session, "reports.operational.view", async (client, opHandle) => {
      const id = parseSavedReportPositiveId(body.id);
      if (!id) return savedReportsJson({ message: "معرّف التقرير غير صالح." }, 400);
      const identity = await staffOperationIdentity(client, opHandle, "reports.operational.view");
      const caps = await staffOperationCapabilities(client, opHandle, "reports.operational.view", STAFF_CAPABILITIES);
      const ownerOps = await staffOperationOwnerOperations(client, opHandle, "reports.operational.view", ["settings.security.change"]);
      const granted = (cap: (typeof STAFF_CAPABILITIES)[number]) => caps.has(cap);
      const isOwner = ownerOps.has("settings.security.change");

      const isShared = typeof body.isShared === "boolean" ? body.isShared : undefined;
      if (isShared !== undefined && !isOwner) {
        return savedReportsJson({ message: "مشاركة التقارير مع الطاقم للمدير فقط." }, 403);
      }

      let view: { reportId: UnifiedReportId; sectionId: ReportSectionId; queryString: string } | undefined;
      if (body.queryString !== undefined) {
        const normalized = normalizeSavedReportQuery(body.reportId, body.queryString);
        if (!canCanonicalAccessUnifiedReport(normalized.reportId, granted)) {
          return savedReportsJson({ message: "ليس لديك صلاحية حفظ هذا التقرير." }, 403);
        }
        view = {
          reportId: normalized.reportId,
          sectionId: normalizeReportSection(body.sectionId),
          queryString: normalized.queryString,
        };
      }

      const saved = await updateSavedReportWith(client, {
        ownerUsername: identity.username,
        id,
        name: body.name === undefined ? undefined : String(body.name),
        isFavorite: typeof body.isFavorite === "boolean" ? body.isFavorite : undefined,
        isShared,
        view,
      });
      return saved ? savedReportsJson({ saved }, 200) : savedReportsJson({ message: "التقرير المحفوظ غير موجود." }, 404);
    });
  } catch (error) {
    return mapSavedReportsRefusal(error, "تعذّر تعديل التقرير المحفوظ.");
  }
}

export async function canonicalSavedReportsDelete(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) {
    return savedReportsJson({ message: "الهوية الموحّدة غير متاحة الآن." }, 503);
  }
  const id = parseSavedReportPositiveId(new URL(request.url).searchParams.get("id"));
  try {
    return await withStaffOperation(getPool(), session, "reports.operational.view", async (client, opHandle) => {
      if (!id) return savedReportsJson({ message: "معرّف التقرير غير صالح." }, 400);
      const identity = await staffOperationIdentity(client, opHandle, "reports.operational.view");
      const removed = await deleteSavedReportWith(client, identity.username, id);
      return removed ? savedReportsJson({ ok: true }, 200) : savedReportsJson({ message: "التقرير المحفوظ غير موجود." }, 404);
    });
  } catch (error) {
    return mapSavedReportsRefusal(error, "تعذّر حذف التقرير المحفوظ.");
  }
}
