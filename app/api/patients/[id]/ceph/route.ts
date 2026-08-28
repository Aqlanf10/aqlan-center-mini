import { NextResponse } from "next/server";
import { createCephAnalysis, listPatientCephAnalyses } from "@/lib/db";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * تحليلات السيفالومتري لمريض.
 *
 * القراءة لأي من يدخل البرنامج — القياسات تُقرأ ولا تُخفى عن من يعالج. والفتح
 * أيضًا مفتوح، لأن فتح مسودة ليس قرارًا سريريًا: الاعتماد هو القرار، وهو محروس
 * في مساره بشروطه (معايرة + معالم كاملة + توقيع).
 */

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const patientIdFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await requireSession())) return denied();
  const patientId = await patientIdFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });

  try {
    const analyses = await listPatientCephAnalyses(patientId);
    return NextResponse.json({ analyses });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل تحليلات السيفالو." }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const patientId = await patientIdFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const documentId = Number(source.documentId);
  if (!Number.isInteger(documentId) || documentId <= 0) {
    return NextResponse.json({ message: "اختر الشععة التي سيُرسم عليها." }, { status: 400 });
  }

  try {
    const created = await createCephAnalysis({
      patientId, documentId, createdBy: session.username,
    });
    if (!created.ok) return NextResponse.json({ message: created.message }, { status: 409 });
    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر فتح التحليل. تأكد من المستند." }, { status: 500 });
  }
}
