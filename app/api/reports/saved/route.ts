import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { canAccessUnifiedReport, isKnownUnifiedReport, type UnifiedReportId } from "@/lib/report-access";
import { templatesForRole } from "@/lib/report-templates";
import {
  SavedReportInputError,
  availableCopyName,
  createSavedReport,
  deleteSavedReport,
  getVisibleSavedReport,
  listSavedReports,
  normalizeReportSection,
  normalizeSavedReportName,
  normalizeSavedReportQuery,
  updateSavedReport,
  type ReportSectionId,
} from "@/lib/saved-reports";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const bad = (message: string, status = 400) => NextResponse.json({ message }, { status });

function positiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET() {
  const session = await requireSession();
  if (!session) return bad("انتهت الجلسة. سجّل الدخول من جديد.", 401);
  try {
    const saved = await listSavedReports(session.username);
    return NextResponse.json({
      // القالب المشترك لا يمنح صلاحية: يُعرض فقط ما يملك المستخدم صلاحية تقريره.
      saved: saved.filter((item) => canAccessUnifiedReport(session.role, item.reportId)),
      templates: templatesForRole(session.role),
      canShare: session.role === "admin",
    });
  } catch {
    return bad("تعذّر تحميل التقارير المحفوظة.", 500);
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return bad("انتهت الجلسة. سجّل الدخول من جديد.", 401);

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return bad("طلب غير صالح.");
  }

  try {
    /* (Reports R3) نسخ تقريرٍ محفوظ (ملكه أو قالبٍ مشترك) إلى نسخةٍ خاصة يعدّلها. */
    if (body.duplicateOf !== undefined) {
      const sourceId = positiveId(body.duplicateOf);
      if (!sourceId) return bad("معرّف التقرير غير صالح.");
      const source = await getVisibleSavedReport(session.username, sourceId);
      if (!source || !canAccessUnifiedReport(session.role, source.reportId)) {
        return bad("التقرير المحفوظ غير موجود.", 404);
      }
      const name = body.name === undefined
        ? await availableCopyName(session.username, source.name)
        : normalizeSavedReportName(body.name);
      const saved = await createSavedReport({
        ownerUsername: session.username,
        name,
        reportId: source.reportId,
        sectionId: source.sectionId,
        queryString: source.queryString,
      });
      return NextResponse.json({ saved }, { status: 201 });
    }

    const name = normalizeSavedReportName(body.name);
    const sectionId = normalizeReportSection(body.sectionId);
    const normalized = normalizeSavedReportQuery(body.reportId, body.queryString);
    if (!isKnownUnifiedReport(normalized.reportId)
        || !canAccessUnifiedReport(session.role, normalized.reportId)) {
      return bad("ليس لديك صلاحية حفظ هذا التقرير.", 403);
    }
    if (body.isShared === true && session.role !== "admin") {
      return bad("مشاركة التقارير مع الطاقم للمدير فقط.", 403);
    }
    const saved = await createSavedReport({
      ownerUsername: session.username,
      name,
      reportId: normalized.reportId,
      sectionId,
      queryString: normalized.queryString,
      isFavorite: body.isFavorite === true,
      isShared: body.isShared === true,
    });
    return NextResponse.json({ saved }, { status: 201 });
  } catch (error) {
    if (error instanceof SavedReportInputError) return bad(error.message);
    return bad("تعذّر حفظ التقرير.", 500);
  }
}

export async function PATCH(request: Request) {
  const session = await requireSession();
  if (!session) return bad("انتهت الجلسة. سجّل الدخول من جديد.", 401);

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return bad("طلب غير صالح.");
  }
  const id = positiveId(body.id);
  if (!id) return bad("معرّف التقرير غير صالح.");

  try {
    const isShared = typeof body.isShared === "boolean" ? body.isShared : undefined;
    if (isShared !== undefined && session.role !== "admin") {
      return bad("مشاركة التقارير مع الطاقم للمدير فقط.", 403);
    }
    /* «حفظ العرض الحالي فوقه»: الرابط الجديد يُنقّى ويُفحص بصلاحية التقرير كالحفظ الأول. */
    let view: { reportId: UnifiedReportId; sectionId: ReportSectionId; queryString: string } | undefined;
    if (body.queryString !== undefined) {
      const normalized = normalizeSavedReportQuery(body.reportId, body.queryString);
      if (!canAccessUnifiedReport(session.role, normalized.reportId)) {
        return bad("ليس لديك صلاحية حفظ هذا التقرير.", 403);
      }
      view = { reportId: normalized.reportId, sectionId: normalizeReportSection(body.sectionId), queryString: normalized.queryString };
    }
    const saved = await updateSavedReport({
      ownerUsername: session.username,
      id,
      name: body.name === undefined ? undefined : String(body.name),
      isFavorite: typeof body.isFavorite === "boolean" ? body.isFavorite : undefined,
      isShared,
      view,
    });
    return saved ? NextResponse.json({ saved }) : bad("التقرير المحفوظ غير موجود.", 404);
  } catch (error) {
    if (error instanceof SavedReportInputError) return bad(error.message);
    return bad("تعذّر تعديل التقرير المحفوظ.", 500);
  }
}

export async function DELETE(request: Request) {
  const session = await requireSession();
  if (!session) return bad("انتهت الجلسة. سجّل الدخول من جديد.", 401);
  const id = positiveId(new URL(request.url).searchParams.get("id"));
  if (!id) return bad("معرّف التقرير غير صالح.");
  try {
    const removed = await deleteSavedReport(session.username, id);
    return removed ? NextResponse.json({ ok: true }) : bad("التقرير المحفوظ غير موجود.", 404);
  } catch {
    return bad("تعذّر حذف التقرير المحفوظ.", 500);
  }
}
