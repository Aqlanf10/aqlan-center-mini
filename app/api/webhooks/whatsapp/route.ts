import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readBoundedBody } from "@/lib/http-body";
import { webhookDeps } from "@/lib/messaging-webhook-deps";
import { whatsAppReceive, whatsAppVerify, type WebhookOutcome } from "@/lib/messaging-webhooks";

export const dynamic = "force-dynamic";

/**
 * (MSG-2) webhook واتساب للأعمال — عام (يطرقه خادم Meta بلا جلسة)، وحارسه:
 * GET رمز التحقق الذي ولّده النظام، وPOST توقيع X-Hub-Signature-256 بالـApp Secret على الجسم الخام.
 * (MSG-3) وعبر المزوّد الشريك (وضع التعايش): مفتاح الاستقبال المولَّد ‎?key=‎ بدل التوقيع.
 */

function respond(outcome: WebhookOutcome): Response {
  if (outcome.text !== undefined) {
    return new Response(outcome.text, { status: outcome.status, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return NextResponse.json(outcome.json ?? {}, { status: outcome.status });
}

export async function GET(request: Request) {
  try {
    return respond(await whatsAppVerify(new URL(request.url).searchParams, webhookDeps));
  } catch {
    return NextResponse.json({ message: "تعذّر التحقق الآن." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let raw: string;
  try {
    raw = (await readBoundedBody(request, JSON_BODY_LIMIT_BYTES)).toString("utf8");
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  try {
    const key = new URL(request.url).searchParams.get("key") ?? "";
    return respond(await whatsAppReceive(raw, request.headers.get("x-hub-signature-256"), webhookDeps, key));
  } catch {
    // 500 ⇒ يعيد Meta المحاولة لاحقًا؛ والتكرار لا يضاعف (معرّف الرسالة فريد).
    return NextResponse.json({ message: "تعذّر حفظ الرسالة الواردة الآن." }, { status: 500 });
  }
}
