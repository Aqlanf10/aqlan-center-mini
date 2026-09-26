import { NextResponse } from "next/server";
import { FORM_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readBoundedBody } from "@/lib/http-body";
import { webhookDeps } from "@/lib/messaging-webhook-deps";
import { smsReceive } from "@/lib/messaging-webhooks";

export const dynamic = "force-dynamic";

/**
 * (MSG-2) الرسائل النصية الواردة من البوابة — عام (تطرقه البوابة بلا جلسة)، وحارسه مفتاح
 * الاستقبال `?key=` الذي ولّده النظام. تُقبل الحقول من العنوان أو جسم form أو JSON،
 * لأن البوابات تختلف في ذلك.
 */

async function handle(request: Request, readBody: boolean) {
  const url = new URL(request.url);
  const fields: Record<string, unknown> = {};
  for (const [name, value] of url.searchParams) if (name !== "key") fields[name] = value;
  if (readBody) {
    let raw: string;
    try {
      raw = (await readBoundedBody(request, FORM_BODY_LIMIT_BYTES)).toString("utf8");
    } catch (error) {
      return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
    }
    const type = request.headers.get("content-type") ?? "";
    if (raw.trim()) {
      if (/json/i.test(type) || raw.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(fields, parsed);
        } catch {
          return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
        }
      } else {
        for (const [name, value] of new URLSearchParams(raw)) if (name !== "key") fields[name] = value;
      }
    }
  }
  try {
    const outcome = await smsReceive(url.searchParams.get("key") ?? "", fields, webhookDeps);
    return NextResponse.json(outcome.json ?? {}, { status: outcome.status });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الرسالة الواردة الآن." }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request, false);
}

export async function POST(request: Request) {
  return handle(request, true);
}
