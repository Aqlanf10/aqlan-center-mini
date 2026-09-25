/**
 * (P2-12) جولة التذكير الآلي — مواعيد الغد تُذكَّر وحدها عبر واتساب للأعمال.
 *
 * «التذكير يُرسَل أو يُقال إنه لم يُرسَل» — لا فشلٌ صامت:
 * - يُختار من ينتظر تذكيرًا بالقاعدة نفسها التي تعدّها شاشة المواعيد (`awaitsReminder`):
 *   محجوز، لم يُذكَّر، وله رقم يصل إليه واتساب.
 * - يُعلَّم «ذُكِّر» **بعد** قبول Meta للرسالة فقط، وبشرط ألّا يكون ذُكِّر في الأثناء
 *   (الموظفة ضغطت الرابط يدويًّا) — فلا تذكيران ولا تذكيرٌ ضائع.
 * - فشلٌ قابل للإعادة (حدّ الإرسال، انقطاع) يُبقي الموعد لجولةٍ لاحقة؛ وفشلٌ دائم في
 *   القالب أو الرمز يوقف الجولة كلها — لا معنى لتكرار الرفض على عشرين مريضًا.
 * - الجولة الواحدة بقفلٍ في القاعدة: ضربتان متزامنتان لا تُرسلان مرتين.
 *
 * منطقٌ خالص بتبعياتٍ محقونة — يُختبر بلا شبكة ولا قاعدة.
 */
import type { Appointment } from "./schedule";
import { awaitsReminder, friendlyDate, friendlyTime, toWhatsAppNumber, type ClinicIdentity } from "./reminders";
import type { SendResult, TemplateMessage } from "./whatsapp-cloud";

/**
 * متغيّرات قالب التذكير بالترتيب الذي يُسجَّل به القالب لدى Meta
 * (docs/WHATSAPP_REMINDERS.md): {{1}} الاسم، {{2}} اليوم والتاريخ، {{3}} الساعة،
 * {{4}} اسم المركز، {{5}} هاتف المركز.
 */
export function reminderTemplateParams(appointment: Appointment, clinic: ClinicIdentity): string[] {
  return [
    appointment.patientName,
    friendlyDate(appointment.scheduledDate),
    friendlyTime(appointment.scheduledTime),
    clinic.name,
    clinic.phone,
  ];
}

export interface AutoReminderDeps {
  appointmentsOn(date: string): Promise<Appointment[]>;
  /** يعلّمه «ذُكِّر» إن لم يُعلَّم بعد؛ false = سبقه غيره. */
  markSentIfPending(appointmentId: number): Promise<boolean>;
  send(message: TemplateMessage): Promise<SendResult>;
}

export interface AutoReminderRun {
  date: string;
  candidates: number;
  sent: number;
  /** ذُكِّروا يدويًّا في أثناء الجولة — أُرسل لهم مرةً آلية، ولم يُعلَّموا مرتين. */
  alreadyMarked: number;
  retryLater: number;
  failed: number;
  /** سبب إيقاف الجولة كلها (قالب/رمز مرفوض)، أو null. */
  stoppedBecause: string | null;
}

export async function runAutoReminders(input: {
  date: string;
  clinic: ClinicIdentity;
  templateName: string;
  languageCode: string;
  /** سقف الجولة الواحدة — لا طوفان رسائل من خطأ في البيانات. */
  limit: number;
}, deps: AutoReminderDeps): Promise<AutoReminderRun> {
  const pending = (await deps.appointmentsOn(input.date)).filter(awaitsReminder).slice(0, input.limit);
  const run: AutoReminderRun = {
    date: input.date, candidates: pending.length, sent: 0, alreadyMarked: 0, retryLater: 0, failed: 0, stoppedBecause: null,
  };
  for (const appointment of pending) {
    const to = toWhatsAppNumber(appointment.patientPhone);
    if (!to) continue;
    const result = await deps.send({
      to,
      templateName: input.templateName,
      languageCode: input.languageCode,
      bodyParams: reminderTemplateParams(appointment, input.clinic),
    });
    if (result.ok) {
      if (await deps.markSentIfPending(appointment.id)) run.sent += 1;
      else run.alreadyMarked += 1;
      continue;
    }
    if (result.retriable) {
      run.retryLater += 1;
      continue;
    }
    run.failed += 1;
    // رفضٌ يخص الرقم وحده لا يوقف الجولة؛ رفض القالب أو الرمز يوقفها.
    if (!result.recipientOnly) {
      run.stoppedBecause = result.message;
      break;
    }
  }
  return run;
}
