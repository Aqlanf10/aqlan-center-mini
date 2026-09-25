import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { canAccessUnifiedReport, isKnownUnifiedReport } from "@/lib/report-access";
import {
  SavedReportInputError,
  createSavedReport,
  deleteSavedReport,
  listSavedReports,
  normalizeReportSection,
  normalizeSavedReportName,
  normalizeSavedReportQuery,
  updateSavedReport,
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
      saved: saved.filter((item) => canAccessUnifiedReport(session.role, item.reportId)),
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
    const name = normalizeSavedReportName(body.name);
    const sectionId = normalizeReportSection(body.sectionId);
    const normalized = normalizeSavedReportQuery(body.reportId, body.queryString);
    if (!isKnownUnifiedReport(normalized.reportId)
        || !canAccessUnifiedReport(session.role, normalized.reportId)) {
      return bad("ليس لديك صلاحية حفظ هذا التقرير.", 403);
    }
    const saved = await createSavedReport({
      ownerUsername: session.username,
      name,
      reportId: normalized.reportId,
      sectionId,
      queryString: normalized.queryString,
      isFavorite: body.isFavorite === true,
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
    const saved = await updateSavedReport({
      ownerUsername: session.username,
      id,
      name: body.name === undefined ? undefined : String(body.name),
      isFavorite: typeof body.isFavorite === "boolean" ? body.isFavorite : undefined,
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
