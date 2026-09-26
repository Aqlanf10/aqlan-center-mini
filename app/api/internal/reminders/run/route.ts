import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  CLINIC_TIME_ZONE, claimAutoReminder, contactConsentStates, getSettingsSafe, listAppointmentsByDate, messagingChannelWithSecret, recordAudit,
  recordMessageDelivery, releaseAutoReminder, withAutoReminderLock,
} from "@/lib/db";
import { runAutoReminders } from "@/lib/auto-reminders";
import { whatsAppSendConfig } from "@/lib/messaging-send";
import { consentAllows, parseConsentMode } from "@/lib/patient-identity";
import { DEFAULT_CLINIC } from "@/lib/reminders";
import { addDays, clinicDateString } from "@/lib/schedule";
import { sendWhatsAppTemplate, whatsAppCloudConfig, type WhatsAppCloudConfig } from "@/lib/whatsapp-cloud";
import type { WhatsAppChannelConfig } from "@/lib/messaging-channels";

/** (MSG-1) قناة واتساب من الإعدادات إن فُعّلت وضُبط رمزها، وإلا مفاتيح البيئة كما كانت. */
async function whatsAppConfig(): Promise<WhatsAppCloudConfig | null> {
  const channel = await messagingChannelWithSecret("whatsapp").catch(() => null);
  const config = channel?.view.config as WhatsAppChannelConfig | undefined;
  if (channel?.view.enabled && channel.secret && config
    && (config.provider === "bsp" ? Boolean(config.apiBaseUrl) : Boolean(config.phoneNumberId))) {
    return whatsAppSendConfig(config, channel.secret);
  }
  return whatsAppCloudConfig();
}

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

  const config = await whatsAppConfig();
  if (!config) return noStore({ ok: false, message: "واتساب للأعمال غير مهيَّأ في بيئة الخادم." }, 503);

  try {
    const settings = await getSettingsSafe();
    if (settings["reminders.auto_enabled"] !== "true") {
      return noStore({ ok: false, reason: "disabled", message: "التذكير الآلي معطَّل من الإعدادات." }, 409);
    }
    const date = addDays(clinicDateString(new Date(), CLINIC_TIME_ZONE), 1);
    /* (PAT-3) من سحب موافقته على واتساب (أو لم يوافق في وضع «بموافقة فقط») لا يُذكَّر آليًّا —
       ويبقى «لم يُذكَّر» أمام الاستقبال. العدد وحده في الرد والتدقيق. */
    const consentMode = parseConsentMode(settings["messaging.consent_mode"]);
    let noConsent = 0;
    const appointmentsOn = async (day: string) => {
      const appointments = await listAppointmentsByDate(day);
      const states = await contactConsentStates(appointments.map((appointment) => appointment.patientId));
      return appointments.filter((appointment) => {
        const allowed = consentAllows(states.get(appointment.patientId)?.whatsapp ?? "unknown", consentMode);
        if (!allowed) noConsent += 1;
        return allowed;
      });
    };
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
      appointmentsOn,
      claim: claimAutoReminder,
      release: releaseAutoReminder,
      send: async (message, appointment) => {
        const result = await sendWhatsAppTemplate(config, message);
        // (MSG-1) كل تذكيرٍ آلي في سجل الرسائل بمريضه — أُرسل أو فشل وسببه.
        await recordMessageDelivery({
          channel: "whatsapp", patientId: appointment.patientId, counterpart: message.to,
          body: `تذكير آلي (${message.templateName}): ${message.bodyParams.join(" · ")}`,
          purpose: "reminder", status: result.ok ? "sent" : "failed",
          providerMessageId: result.ok ? result.messageId : null, error: result.ok ? null : result.message,
          createdBy: "system",
        }).catch(() => null);
        return result;
      },
    }));
    if (outcome.busy) return noStore({ ok: false, reason: "busy", message: "جولة تذكيرٍ أخرى تعمل الآن." }, 409);

    const run = outcome.result;
    await recordAudit({
      action: "reminder.auto",
      entity: "appointment_reminders",
      entityId: run.date,
      details: { ...run, noConsent },
      actor: "system",
    });
    return noStore({ ok: run.stoppedBecause === null, ...run, noConsent }, 200);
  } catch {
    return noStore({ ok: false, message: "تعذّرت جولة التذكير الآلي. لم يُعلَّم شيءٌ لم يُرسَل." }, 500);
  }
}
