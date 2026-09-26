import { NextResponse } from "next/server";
import { SETTINGS_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { listMessagingChannels, saveMessagingChannel } from "@/lib/db";
import { isChannel, normalizeChannelConfig } from "@/lib/messaging-channels";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (MSG-1) إعدادات قنوات المراسلة — للمدير وحده.
 *
 * GET: القنوات الثلاث بإعداداتها وحالة سرّها (مضبوط/غير مضبوط) — السرّ نفسه لا يُعاد أبدًا.
 * PUT: قناةٌ واحدة: التفعيل والإعدادات، و`secret` جديد يستبدل القديم (مشفّرًا)، و
 * `removeSecret: true` يحذفه؛ وغيابهما يُبقيه كما هو.
 */

const noStore = (body: unknown, status: number) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function admin() {
  const session = await requireSession();
  if (!session) return { error: noStore({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, 401) } as const;
  if (!isAdmin(session.role)) return { error: noStore({ message: "إعدادات قنوات المراسلة للمدير وحده." }, 403) } as const;
  return { session } as const;
}

export async function GET() {
  const auth = await admin();
  if ("error" in auth) return auth.error;
  try {
    return noStore({ channels: await listMessagingChannels() }, 200);
  } catch {
    return noStore({ message: "تعذّر تحميل إعدادات القنوات." }, 500);
  }
}

export async function PUT(request: Request) {
  const auth = await admin();
  if ("error" in auth) return auth.error;
  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES);
    body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return noStore({ message: "طلب غير صالح." }, 400);
  }
  if (!isChannel(body.channel)) return noStore({ message: "قناة غير معروفة." }, 400);
  const enabled = body.enabled === true;
  const normalized = normalizeChannelConfig(body.channel, body.config, enabled);
  if (!normalized.ok) return noStore({ message: normalized.message }, 400);
  const secret = body.removeSecret === true
    ? null
    : typeof body.secret === "string" && body.secret.trim() ? body.secret.trim().slice(0, 2000) : undefined;

  try {
    const current = (await listMessagingChannels()).find((row) => row.channel === body.channel);
    const willHaveSecret = secret === undefined ? Boolean(current?.hasSecret) : secret !== null;
    if (enabled && !willHaveSecret) {
      return noStore({ message: "أدخل السرّ (الرمز أو المفتاح أو كلمة المرور) قبل تفعيل القناة." }, 400);
    }
    const saved = await saveMessagingChannel({
      channel: body.channel, enabled, config: normalized.config, secret,
      actor: auth.session.username, actorRole: auth.session.role,
    });
    return noStore({ channel: saved }, 200);
  } catch {
    return noStore({ message: "تعذّر حفظ إعدادات القناة." }, 500);
  }
}
