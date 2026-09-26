/**
 * (P2-12) جولة التذكير الآلي — مواعيد الغد تُذكَّر وحدها عبر واتساب للأعمال.
 *
 * «التذكير يُرسَل أو يُقال إنه لم يُرسَل» — لا فشلٌ صامت:
 * - يُختار من ينتظر تذكيرًا بالقاعدة نفسها التي تعدّها شاشة المواعيد (`awaitsReminder`):
 *   محجوز، لم يُذكَّر، وله رقم يصل إليه واتساب.
 * - يُدَّعى الموعد **قبل** الإرسال ذرّيًّا وبنسخته (اليوم والساعة والحالة): ما ذُكِّر يدويًّا أو
 *   نُقل أو أُلغي في الأثناء لا يُرسل له — فلا تذكيران ولا تذكيرٌ بموعدٍ قديم. وإن فشل الإرسال
 *   رُدّ الادعاء، فيبقى الموعد «لم يُذكَّر» أمام الموظفة وللجولة التالية.
 * - فشلٌ عابر (حدّ الإرسال، انقطاع) يُعاد داخل الجولة مرتين قبل ردّ الموعد؛ وفشلٌ دائم في
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
  /**
   * يدّعي تذكير **هذه النسخة** من الموعد (اليوم والساعة والحالة كما قُرئت) قبل الإرسال،
   * فيُعلَّم «ذُكِّر» ذرّيًّا. null = ذُكِّر يدويًّا أو نُقل أو أُلغي في الأثناء — فلا يُرسل.
   */
  claim(appointment: Appointment): Promise<string | null>;
  /** يعيد الادعاء إن فشل الإرسال — وبشرط أنه ما زال ادعاءنا (لا يمحو تذكيرًا يدويًّا لاحقًا). */
  release(appointmentId: number, token: string): Promise<void>;
  send(message: TemplateMessage): Promise<SendResult>;
  /** انتظارٌ بين محاولات الفشل العابر — يُحقن للاختبار. */
  sleep?(ms: number): Promise<void>;
}

export interface AutoReminderRun {
  date: string;
  candidates: number;
  sent: number;
  /** لم يُدَّعَ: ذُكِّر يدويًّا أو نُقل أو أُلغي بين القراءة والإرسال — لا رسالة. */
  skipped: number;
  retryLater: number;
  failed: number;
  /** سبب إيقاف الجولة كلها (قالب/رمز مرفوض)، أو null. */
  stoppedBecause: string | null;
}

/** فشلٌ عابر (حدّ الإرسال، انقطاع) يُعاد داخل الجولة نفسها قبل أن يُردّ الموعد. */
const RETRY_DELAYS_MS = [2_000, 5_000];

export async function runAutoReminders(input: {
  date: string;
  clinic: ClinicIdentity;
  templateName: string;
  languageCode: string;
  /** سقف الجولة الواحدة — لا طوفان رسائل من خطأ في البيانات. */
  limit: number;
}, deps: AutoReminderDeps): Promise<AutoReminderRun> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pending = (await deps.appointmentsOn(input.date)).filter(awaitsReminder).slice(0, input.limit);
  const run: AutoReminderRun = {
    date: input.date, candidates: pending.length, sent: 0, skipped: 0, retryLater: 0, failed: 0, stoppedBecause: null,
  };
  for (const appointment of pending) {
    const to = toWhatsAppNumber(appointment.patientPhone);
    if (!to) continue;
    const token = await deps.claim(appointment);
    if (!token) {
      run.skipped += 1;
      continue;
    }
    const message = {
      to,
      templateName: input.templateName,
      languageCode: input.languageCode,
      bodyParams: reminderTemplateParams(appointment, input.clinic),
    };
    let result = await deps.send(message);
    for (const delay of RETRY_DELAYS_MS) {
      if (result.ok || !result.retriable) break;
      await sleep(delay);
      result = await deps.send(message);
    }
    if (result.ok) {
      run.sent += 1;
      continue;
    }
    await deps.release(appointment.id, token);
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
