import { NextResponse } from "next/server";
import { FORM_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readBoundedBody } from "@/lib/http-body";
import { webhookDeps } from "@/lib/messaging-webhook-deps";
import { constantTimeEqual } from "@/lib/messaging-inbound";
import { smsReceive } from "@/lib/messaging-webhooks";

export const dynamic = "force-dynamic";

/**
 * (MSG-2) الرسائل النصية الواردة من البوابة — عام (تطرقه البوابة بلا جلسة)، وحارسه مفتاح
 * الاستقبال `?key=` الذي ولّده النظام. تُقبل الحقول من العنوان أو جسم form أو JSON،
 * لأن البوابات تختلف في ذلك.
 */

function extractWebhookKey(request: Request, url: URL): string {
  const headerKey = request.headers.get("x-webhook-key")?.trim();
  if (headerKey) return headerKey;
  const auth = request.headers.get("authorization")?.trim() ?? "";
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return url.searchParams.get("key") ?? "";
}

async function handle(request: Request, readBody: boolean) {
  const url = new URL(request.url);
  const key = extractWebhookKey(request, url);
  if (!readBody && process.env.SMS_WEBHOOK_ALLOW_GET !== "true") {
    const channel = await webhookDeps.channel("sms");
    const expected = typeof channel.config.inboundKey === "string" ? channel.config.inboundKey : "";
    if (!expected || !key || !constantTimeEqual(key, expected)) {
      return NextResponse.json({ message: "طلب غير مصرّح به." }, { status: 403 });
    }
    return NextResponse.json(
      { message: "استعمل POST لاستقبال الرسائل الواردة." },
      { status: 405, headers: { Allow: "POST" } },
    );
  }
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
    const outcome = await smsReceive(key, fields, webhookDeps);
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
