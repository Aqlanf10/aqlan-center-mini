import { NextResponse } from "next/server";
import { updateFamilyDetails } from "@/lib/db";
import { idOf, json, readBody } from "@/lib/case-route";
import { buildFamilyView } from "@/lib/family-view";
import { familyFailure, familyResponse, familyWriter } from "@/lib/family-route";
import { parseFamilyName, parseFamilyNote } from "@/lib/patient-families";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** (PAT-4) العائلة كما يراها صاحب الجلسة: الأفراد بوصوله إليهم، والأرصدة لمن يرى المال. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return json("انتهت الجلسة. سجّل الدخول من جديد.", 401);
  const familyId = idOf((await params).id);
  if (!familyId) return json("رقم العائلة غير صالح.", 400);
  try {
    const result = await buildFamilyView(session, familyId);
    if (!result.ok) {
      return result.reason === "not_found" ? json("لا توجد عائلة بهذا الرقم.", 404) : json("غير مصرّح لك بهذه العائلة.", 403);
    }
    return NextResponse.json(result.view);
  } catch {
    return json("تعذّر تحميل العائلة.", 500);
  }
}

/** تعديل اسم العائلة أو ملاحظتها. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await familyWriter();
  if (!guard.ok) return guard.response;
  const familyId = idOf((await params).id);
  if (!familyId) return json("رقم العائلة غير صالح.", 400);
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const update: { name?: string; note?: string | null } = {};
  if (read.body.name !== undefined) {
    const name = parseFamilyName(read.body.name);
    if (!name.ok) return json(name.message, 400);
    update.name = name.value;
  }
  if (read.body.note !== undefined) {
    const note = parseFamilyNote(read.body.note);
    if (!note.ok) return json(note.message, 400);
    update.note = note.value;
  }
  if (update.name === undefined && update.note === undefined) return json("لا تعديل في الطلب.", 400);
  try {
    const result = await updateFamilyDetails({ familyId, ...update }, { actor: guard.session.username, actorRole: guard.session.role });
    if (!result.ok) return familyFailure(result.reason);
    return familyResponse(guard.session, result.family);
  } catch {
    return json("تعذّر حفظ العائلة. أعد المحاولة.", 500);
  }
}
