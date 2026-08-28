import { NextResponse } from "next/server";
import {
  discardCephAnalysis, getCephStudy, updateCephCalibration, updateCephLandmarks,
  type CephCalibrationInput,
} from "@/lib/db";
import { isCephLandmarkCode } from "@/lib/ceph";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * تحليل سيفالومتري واحد: قراءة، وكتابة مسودة، ورفض.
 *
 * الكتابة كلها تمرّ من دوالّ النطاق التي ترفض المس بمعتمد — والمسار هنا مجرد
 * باب يتحقق من شكل الطلب. والرفض (DELETE) إخفاءٌ موثَّق للمسودة لا حذفًا: صفٌّ
 * يبقى بشهادة رافضه، كما في المستندات.
 */

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const idFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await requireSession())) return denied();
  const id = await idFrom(context);
  if (!id) return NextResponse.json({ message: "رقم التحليل غير صالح." }, { status: 400 });

  try {
    const study = await getCephStudy(id);
    if (!study) return NextResponse.json({ message: "التحليل غير موجود." }, { status: 404 });
    return NextResponse.json(study);
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل التحليل." }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const id = await idFrom(context);
  if (!id) return NextResponse.json({ message: "رقم التحليل غير صالح." }, { status: 400 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  try {
    // المعايرة: أربعة أرقام ومسافة حقيقية — كلها لا تنقص واحدة.
    if (source.calibration != null) {
      const c = source.calibration as Record<string, unknown>;
      const x1 = num(c.x1), y1 = num(c.y1), x2 = num(c.x2), y2 = num(c.y2), mm = num(c.mm);
      if (x1 == null || y1 == null || x2 == null || y2 == null || mm == null || mm <= 0) {
        return NextResponse.json(
          { message: "المعايرة تحتاج نقطتين ومسافة حقيقية بالمليمتر." }, { status: 400 },
        );
      }
      const cal: CephCalibrationInput = { x1, y1, x2, y2, mm };
      const done = await updateCephCalibration(id, cal, session.username);
      if (!done.ok) return NextResponse.json({ message: done.message }, { status: 409 });
    }

    // المعالم: دفعة نقاط برموز معلومة.
    if (source.landmarks != null) {
      if (!Array.isArray(source.landmarks)) {
        return NextResponse.json({ message: "المعالم تُرسل مصفوفة." }, { status: 400 });
      }
      const points = (source.landmarks as Record<string, unknown>[])
        .map((raw) => ({
          code: isCephLandmarkCode(raw.code) ? raw.code : null,
          x: num(raw.x), y: num(raw.y),
          source: raw.source === "suggested" ? ("suggested" as const) : ("manual" as const),
        }))
        .filter((p): p is { code: NonNullable<typeof p.code>; x: number; y: number; source: "manual" | "suggested" } =>
          p.code != null && p.x != null && p.y != null);
      const done = await updateCephLandmarks(id, points, session.username);
      if (!done.ok) return NextResponse.json({ message: done.message }, { status: 409 });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ التعديل." }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const id = await idFrom(context);
  if (!id) return NextResponse.json({ message: "رقم التحليل غير صالح." }, { status: 400 });

  let note: string | null = null;
  try {
    const body = await request.json() as Record<string, unknown> | null;
    if (body && typeof body.note === "string") note = body.note;
  } catch { /* الرفض بلا ملاحظة جائز */ }

  try {
    const done = await discardCephAnalysis(id, session.username, note);
    if (!done.ok) return NextResponse.json({ message: done.message }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر رفض المسودة." }, { status: 500 });
  }
}
