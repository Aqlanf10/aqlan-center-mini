import { NextResponse } from "next/server";
import { createPatientFamily, findFamiliesByPhone, searchPatientFamilies } from "@/lib/db";
import { json, readBody } from "@/lib/case-route";
import { familyFailure, familyResponse, familyWriter } from "@/lib/family-route";
import { validateFamilyDraft } from "@/lib/patient-families";

export const dynamic = "force-dynamic";

/**
 * (PAT-4) البحث عن عائلة لربط مريضٍ بها (`?q=`)، واقتراح «ربط بعائلة …» عند التسجيل من الجوال
 * (`?phone=`) — للاستقبال والإدارة (من يربط).
 */
export async function GET(request: Request) {
  const guard = await familyWriter();
  if (!guard.ok) return guard.response;
  const url = new URL(request.url);
  const phone = (url.searchParams.get("phone") ?? "").trim().slice(0, 40);
  const term = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  try {
    if (phone) return NextResponse.json({ suggestions: await findFamiliesByPhone(phone) });
    if (term) return NextResponse.json({ families: await searchPatientFamilies(term) });
    return NextResponse.json({ families: [] });
  } catch {
    return json("تعذّر البحث عن العائلات.", 500);
  }
}

/** إنشاء عائلة باسمها وضامنها الاختياري وأفرادها الأوّلين. */
export async function POST(request: Request) {
  const guard = await familyWriter();
  if (!guard.ok) return guard.response;
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const draft = validateFamilyDraft(read.body);
  if (!draft.ok) return json(draft.message, 400);
  try {
    const result = await createPatientFamily(draft.value, { actor: guard.session.username, actorRole: guard.session.role });
    if (!result.ok) return familyFailure(result.reason);
    return familyResponse(guard.session, result.family, 201);
  } catch {
    return json("تعذّر إنشاء العائلة. أعد المحاولة.", 500);
  }
}
