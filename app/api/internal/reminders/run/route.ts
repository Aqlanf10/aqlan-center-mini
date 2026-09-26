import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  CLINIC_TIME_ZONE, claimAutoReminder, getSettingsSafe, listAppointmentsByDate, recordAudit, releaseAutoReminder, withAutoReminderLock,
} from "@/lib/db";
import { runAutoReminders } from "@/lib/auto-reminders";
import { DEFAULT_CLINIC } from "@/lib/reminders";
import { addDays, clinicDateString } from "@/lib/schedule";
import { sendWhatsAppTemplate, whatsAppCloudConfig } from "@/lib/whatsapp-cloud";

export const dynamic = "force-dynamic";

/**
 * (P2-12) جولة التذكير الآلي — يضربها المجدول الخارجي مرةً مساءً (كجولة النسخ).
 *
 * - سرٌّ مخصص `INTERNAL_REMINDERS_RUN_TOKEN` في ترويسة Bearer فقط، بمقارنةٍ ثابتة الزمن.
 * - لا إرسال حتى تكتمل الثلاثة: مفاتيح واتساب للأعمال في البيئة، والإعداد
 *   `reminders.auto_enabled`، وقالبٌ باسمٍ صالح. الناقص فشلٌ مغلق برسالة عربية.
 * - مواعيد **الغد** بتوقيت المركز، بقفلٍ في القاعدة (لا جولتان معًا)، وسقف ٣٠٠ رسالة.
 * - الاستجابة أرقامٌ فقط: لا أسماء ولا هواتف ولا أسرار. وسطرٌ في سجل التدقيق بالأرقام نفسها.
 */

const TOKEN_ENV = "INTERNAL_REMINDERS_RUN_TOKEN";
const RUN_LIMIT = 300;

const noStore = (body: unknown, status: number) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

function secretMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const expected = process.env[TOKEN_ENV]?.trim() ?? "";
  if (!expected) return noStore({ ok: false, message: "نقطة التذكير الآلي غير مهيَّأة." }, 503);
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  if (!provided || !secretMatches(provided, expected)) {
    return noStore({ ok: false, message: "رمز التشغيل غير صحيح." }, 401);
  }

  const config = whatsAppCloudConfig();
  if (!config) return noStore({ ok: false, message: "واتساب للأعمال غير مهيَّأ في بيئة الخادم." }, 503);

  try {
    const settings = await getSettingsSafe();
    if (settings["reminders.auto_enabled"] !== "true") {
      return noStore({ ok: false, reason: "disabled", message: "التذكير الآلي معطَّل من الإعدادات." }, 409);
    }
    const date = addDays(clinicDateString(new Date(), CLINIC_TIME_ZONE), 1);
    const outcome = await withAutoReminderLock(() => runAutoReminders({
      date,
      clinic: {
        name: settings["clinic.name"]?.trim() || DEFAULT_CLINIC.name,
        phone: settings["clinic.phone"]?.trim() || DEFAULT_CLINIC.phone,
      },
      templateName: settings["reminders.auto_template"] || "appointment_reminder",
      languageCode: settings["reminders.auto_language"] || "ar",
      limit: RUN_LIMIT,
    }, {
      appointmentsOn: listAppointmentsByDate,
      claim: claimAutoReminder,
      release: releaseAutoReminder,
      send: (message) => sendWhatsAppTemplate(config, message),
    }));
    if (outcome.busy) return noStore({ ok: false, reason: "busy", message: "جولة تذكيرٍ أخرى تعمل الآن." }, 409);

    const run = outcome.result;
    await recordAudit({
      action: "reminder.auto",
      entity: "appointment_reminders",
      entityId: run.date,
      details: { ...run },
      actor: "system",
    });
    return noStore({ ok: run.stoppedBecause === null, ...run }, 200);
  } catch {
    return noStore({ ok: false, message: "تعذّرت جولة التذكير الآلي. لم يُعلَّم شيءٌ لم يُرسَل." }, 500);
  }
}
