/**
 * أدوات تنفيذ العمليات والإجراءات التفاعلية المباشرة (Operational Action Tools)
 * لمركز الدكتور عقلان الكامل لطب وجراحة وتقويم الأسنان.
 *
 * تتيح للمساعد الذكي تنفيذ الأوامر والعمليات التشغيلية كاملة:
 * 1. تسجيل وإضافة مريض جديد (create_patient)
 * 2. حجز موعد مباشر لمريض (book_appointment)
 * 3. تعديل حالة موعد / وصول / إلغاء (update_appointment_status)
 * 4. تسجيل سند قبض ودفعات مالية (record_patient_payment)
 * 5. تسجيل وتحديث التنبيه الطبي والحساسية (add_patient_medical_alert)
 * 6. إنشاء أمر وحالة معمل جديدة (create_lab_order)
 * 7. تسجيل حركات المخزون والإدخال والصرف (record_inventory_movement)
 * 8. توليد رسائل تذكير الواتساب المباشرة (generate_whatsapp_reminder)
 */

import {
  createPatient,
  doctorOwnedPatientIds,
  getPatient,
  updatePatient,
  searchPatients,
  createAppointment,
  listAppointmentsByDate,
  arriveAppointment,
  setAppointmentStatus,
  deleteAppointment,
  recordPayment,
  getSettings,
  createLabOrder,
  listLabNames,
  listParties,
  createInventoryMovement,
  listInventoryItems,
  recordAudit,
  CLINIC_TIME_ZONE,
} from "../db";
import { isCurrency, parseAmount, formatMoney, type Currency } from "../money";
import { rateFromSettings } from "../settings";
import { addDays, clinicDateString } from "../schedule";
import { toWhatsAppNumber } from "../reminders";
import { canHandleMoney, canManageInventory, isAdmin } from "../roles";
import type { AiToolContext, ToolExecutionResult, KpiCard, ActionButton } from "./types";


/** مجال بحث المرضى حسب دور المستخدم: الطبيب بلا منحٍ عامة يبحث في مرضاه فقط. */
function doctorScopeIdFor(context: AiToolContext): number | null {
  if (context.role !== "doctor" && context.userRole !== "doctor") return null;
  if (context.canViewAllPatients || context.permissions?.canViewAllPatients) return null;
  return context.doctorPartyId ?? null;
}

/** بحث مرضى مقيّد بمجال الطبيب — دفاعٌ في العمق فوق بوابة السياسة المركزية. */
async function scopedSearchPatients(
  name: string,
  limit: number,
  context: AiToolContext,
) {
  return searchPatients(name.trim(), limit, doctorScopeIdFor(context));
}

// ─── 1. تسجيل مريض جديد ────────────────────────────────────────────────────────

export async function createPatientAction(
  params: {
    fullName: string;
    phone?: string;
    altPhone?: string;
    gender?: "male" | "female";
    birthYear?: number;
    address?: string;
    medicalAlert?: string;
    note?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const fullName = (params.fullName || "").trim();
  if (!fullName || fullName.length < 2) {
    return {
      success: false,
      textSummary: "❌ **تعذّر تسجيل المريض:** يرجى كتابة اسم المريض الثلاثي أو الثنائي على الأقل.",
    };
  }

  /* الصلاحية (canAddPatient) تُفحص في بوابة السياسة المركزية قبل الوصول إلى
     هنا — الطبيب المعطّلة لديه إضافة المرضى يُرفض هناك؛ هذا الحاجز القديم
     الفارغ أُزيل لأنه كان يوهم بفحصٍ لا ينفّذ شيئًا. */
  const role = context.role || context.userRole || "reception";

  if (!context.isDbConnected) {
    return {
      success: true,
      textSummary: `✅ **[وضع تجريبي] تم تسجيل المريض الجديد بنجاح:**\n• **الاسم:** ${fullName}\n• **الهاتف:** ${params.phone || "غير محدد"}\n• **رقم الملف:** P-9999\n• **التنبيه الطبي:** ${params.medicalAlert || "سليم"}`,
      cards: [
        { title: "المريض الجديد", value: fullName, tone: "good" },
        { title: "رقم الملف", value: "P-9999", tone: "info" },
      ],
    };
  }

  try {
    const patient = await createPatient({
      fullName,
      phone: params.phone || "",
      altPhone: params.altPhone || "",
      gender: params.gender || "male",
      birthYear: params.birthYear ? Number(params.birthYear) : null,
      address: params.address || null,
      medicalAlert: params.medicalAlert || null,
      note: params.note || "تم التسجيل بواسطة المساعد الذكي",
    });

    await recordAudit({
      action: "patient.create",
      entity: "patient",
      entityId: String(patient.id),
      entityLabel: `${patient.fullName} (${patient.patientNumber})`,
      details: {
        registeredBy: "ai_assistant",
        fullName: patient.fullName,
        phone: patient.phone,
        medicalAlert: patient.medicalAlert,
      },
      actor: context.username || "ai_assistant",
      actorRole: role,
    });

    const cards: KpiCard[] = [
      { title: "المريض الجديد", value: patient.fullName, tone: "good" },
      { title: "رقم الملف", value: patient.patientNumber, tone: "info" },
      { title: "الهاتف", value: patient.phone || "غير مسجل", tone: "calm" },
    ];

    if (patient.medicalAlert) {
      cards.push({ title: "⚠️ تنبيه طبي", value: patient.medicalAlert, tone: "warn" });
    }

    const actions: ActionButton[] = [
      { label: `فتح ملف ${patient.fullName}`, href: `/patients/${patient.id}`, actionType: "navigate" },
      { label: "حجز موعد له الآن", href: `/appointments?patientId=${patient.id}`, actionType: "navigate" },
    ];

    const textSummary = `✅ **تم بنجاح فتح ملف المريض وتسجيله في المركز:**\n• **الاسم:** ${patient.fullName}\n• **رقم الملف:** \`${patient.patientNumber}\`\n• **الهاتف:** \`${patient.phone || "غير مسجل"}\`${patient.medicalAlert ? `\n• ⚠️ **تنبيه طبي:** ${patient.medicalAlert}` : ""}\n\nيمكنك الآن فتح ملفه السريري مباشرة أو حجز موعد له عبر الأزرار أدناه.`;

    return {
      success: true,
      textSummary,
      cards,
      actions,
      patientIdAccessed: patient.id,
      data: patient,
    };
  } catch (err) {
    return {
      success: false,
      textSummary: `❌ **تعذّر تسجيل المريض:** ${(err as Error).message}`,
      warnings: [(err as Error).message],
    };
  }
}

// ─── 2. حجز موعد مباشر لمريض ──────────────────────────────────────────────────

export async function bookAppointmentAction(
  params: {
    patientId?: number;
    patientName?: string;
    date?: string;
    time?: string;
    durationMinutes?: number;
    appointmentType?: string;
    doctorId?: number;
    doctorName?: string;
    note?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const today = context.todayISO || clinicDateString(new Date(), CLINIC_TIME_ZONE);

  // تحديد تاريخ الموعد
  let scheduledDate = params.date ? params.date.trim() : today;
  if (scheduledDate === "today" || scheduledDate === "اليوم") {
    scheduledDate = today;
  } else if (scheduledDate === "tomorrow" || scheduledDate === "بكرة" || scheduledDate === "غدا" || scheduledDate === "غداً") {
    scheduledDate = addDays(today, 1);
  }

  // تحديد وقت الموعد (افتراضي: الساعة 16:00 عصراً إن لم يحدد)
  let scheduledTime = (params.time || "16:00").trim();
  if (scheduledTime.length === 4 && scheduledTime.includes(":")) {
    scheduledTime = "0" + scheduledTime;
  } else if (/^\d{1,2}$/.test(scheduledTime)) {
    scheduledTime = `${scheduledTime.padStart(2, "0")}:00`;
  }

  const duration = Number(params.durationMinutes) || 30;

  if (!context.isDbConnected) {
    return {
      success: true,
      textSummary: `📅 **[وضع تجريبي] تم حجز الموعد بنجاح:**\n• **المريض:** ${params.patientName || "مريض تجريبي"}\n• **التاريخ:** ${scheduledDate}\n• **الوقت:** ${scheduledTime}\n• **المدة:** ${duration} دقيقة\n• **النوع:** ${params.appointmentType || "كشف واستشارة"}`,
      cards: [
        { title: "حالة الحجز", value: "مؤكد ✅", tone: "good" },
        { title: "التاريخ والوقت", value: `${scheduledDate} ${scheduledTime}`, tone: "info" },
      ],
      actions: [{ label: "فتح جدول المواعيد", href: "/appointments", actionType: "navigate" }],
    };
  }

  try {
    // 1. العثور على المريض
    let targetPatientId = params.patientId;
    let patientName = params.patientName || "";

    if (!targetPatientId && params.patientName) {
      const matches = await scopedSearchPatients(params.patientName, 3, context);
      if (matches.length === 1) {
        targetPatientId = matches[0].id;
        patientName = matches[0].fullName;
      } else if (matches.length > 1) {
        return {
          success: false,
          textSummary: `🔍 **يوجد أكثر من مريض يطابق اسم «${params.patientName}»:**\n${matches
            .map((m) => `• **${m.fullName}** (\`${m.patientNumber}\` - هاتف: ${m.phone || "بدون"})`)
            .join("\n")}\n\nيرجى تحديد رقم ملف المريض أو اسمه بالكامل للحجز بدقة.`,
        };
      } else {
        return {
          success: false,
          textSummary: `❌ لم أجد مريضاً مسجلاً باسم «${params.patientName}». يمكنك أن تطلب مني أولاً: «أضف مريض جديد باسم ${params.patientName}» ثم حجز الموعد له.`,
        };
      }
    } else if (targetPatientId) {
      const p = await getPatient(targetPatientId);
      if (p) patientName = p.fullName;
    }

    if (!targetPatientId) {
      return {
        success: false,
        textSummary: "❌ يرجى تحديد اسم المريض أو رقم ملفه لحجز الموعد.",
      };
    }

    // 2. فحص الطبيب إن وجد
    let doctorId = params.doctorId || null;
    let doctorDisplayName = params.doctorName || null;
    if (!doctorId && params.doctorName) {
      const doctors = await listParties("doctor").catch(() => []);
      const matchedDoc = doctors.find((d) => d.name.includes(params.doctorName!.trim()));
      if (matchedDoc) {
        doctorId = matchedDoc.id;
        doctorDisplayName = matchedDoc.name;
      }
    } else if (context.role === "doctor" && context.doctorPartyId) {
      doctorId = context.doctorPartyId;
    }

    // 3. إنشاء الموعد
    const appointment = await createAppointment({
      patientId: targetPatientId,
      date: scheduledDate,
      time: scheduledTime,
      durationMinutes: duration,
      appointmentType: params.appointmentType || "كشف ومعاينة",
      note: params.note || "تم الحجز عبر المساعد الذكي",
    });

    if (!appointment) {
      return {
        success: false,
        textSummary: "❌ تعذّر حجز الموعد في قاعدة البيانات. تحقق من توفر الوقت والبيانات.",
      };
    }

    await recordAudit({
      action: "appointment.create",
      entity: "appointment",
      entityId: String(appointment.id),
      entityLabel: `موعد: ${patientName} (${scheduledDate} ${scheduledTime})`,
      details: {
        patientId: targetPatientId,
        date: scheduledDate,
        time: scheduledTime,
        type: params.appointmentType,
        bookedBy: "ai_assistant",
      },
      actor: context.username || "ai_assistant",
      actorRole: context.role,
    });

    const cards: KpiCard[] = [
      { title: "حالة الموعد", value: "مجدول بنجاح ⏳", tone: "good" },
      { title: "المريض", value: patientName, tone: "info" },
      { title: "الموعد", value: `${scheduledDate} الساعة ${scheduledTime}`, tone: "calm" },
    ];

    if (doctorDisplayName) {
      cards.push({ title: "الطبيب المعالج", value: `د. ${doctorDisplayName}`, tone: "info" });
    }

    const actions: ActionButton[] = [
      { label: "فتح جدول المواعيد", href: `/appointments?date=${scheduledDate}`, actionType: "navigate" },
      { label: `ملف ${patientName}`, href: `/patients/${targetPatientId}`, actionType: "navigate" },
    ];

    const textSummary = `✅ **تم بنجاح تثبيت موعد المريض في الجدول:**\n• **المريض:** **${patientName}**\n• **التاريخ:** 📅 **${scheduledDate}**\n• **الوقت:** ⏰ **${scheduledTime}** (المدة: ${duration} دقيقة)\n• **النوع:** ${appointment.appointmentType || "كشف"}${doctorDisplayName ? `\n• **الطبيب:** د. ${doctorDisplayName}` : ""}\n\nتم إدراج الموعد رسمياً في شاشات الاستقبال والعيادة.`;

    return {
      success: true,
      textSummary,
      cards,
      actions,
      patientIdAccessed: targetPatientId,
      data: appointment,
    };
  } catch (err) {
    return {
      success: false,
      textSummary: `❌ تعذّر حجز الموعد: ${(err as Error).message}`,
      warnings: [(err as Error).message],
    };
  }
}

// ─── 3. تعديل حالة موعد (وصول / إلغاء / إنهاء) ───────────────────────────────

export async function updateAppointmentStatusAction(
  params: {
    appointmentId?: number;
    patientName?: string;
    patientId?: number;
    action: "arrive" | "cancel" | "done" | "no_show";
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const today = context.todayISO || clinicDateString(new Date(), CLINIC_TIME_ZONE);

  if (!context.isDbConnected) {
    return {
      success: true,
      textSummary: `✅ **[وضع تجريبي] تم تحديث حالة الموعد إلى (${params.action}) بنجاح.**`,
      cards: [{ title: "حالة الإجراء", value: "تم التحديث", tone: "good" }],
    };
  }

  try {
    let appointmentId = params.appointmentId;

    // إذا لم يمرر رقم الموعد بل اسم المريض، نبحث في مواعيد اليوم
    if (!appointmentId && (params.patientName || params.patientId)) {
      let todayAppointments = await listAppointmentsByDate(today).catch(() => []);
      /* عزل الطبيب: جدول زملائه لا يُفتح — مواعيده ومواعيد مرضاه وغير المسندة
         فقط (نفس منطق مسار /api/appointments). */
      if (context.role === "doctor" && !context.permissions?.canViewAllAppointments && context.doctorPartyId) {
        const candidateIds = Array.from(new Set(todayAppointments.map((a) => a.patientId)));
        const owned = await doctorOwnedPatientIds(context.doctorPartyId, candidateIds).catch(() => new Set<number>());
        todayAppointments = todayAppointments.filter(
          (a) => !a.doctorId || a.doctorId === context.doctorPartyId || owned.has(a.patientId),
        );
      }
      const match = todayAppointments.find((a) => {
        if (params.patientId && a.patientId === params.patientId) return true;
        if (params.patientName && a.patientName.includes(params.patientName.trim())) return true;
        return false;
      });

      if (match) {
        appointmentId = match.id;
      } else {
        return {
          success: false,
          textSummary: `❌ لم أجد موعداً مسجلاً اليوم للمريض «${params.patientName || params.patientId}». يرجى التأكد من جدول اليوم أو تحديد رقم الموعد.`,
        };
      }
    }

    if (!appointmentId) {
      return {
        success: false,
        textSummary: "❌ يرجى تحديد رقم الموعد أو اسم المريض المراد تعديل حالته.",
      };
    }

    let updatedMsg = "";
    if (params.action === "arrive") {
      const ok = await arriveAppointment(appointmentId);
      if (!ok) {
        return { success: false, textSummary: "⚠️ تعذّر تسجيل الحضور (ربما سُجل وصوله مسبقاً أو أن الموعد قد أُنجز)." };
      }
      updatedMsg = "تم تسجيل وصول المريض إلى صالة الانتظار وفتح طابور الكشف بنجاح 🚶";
    } else if (params.action === "cancel") {
      await setAppointmentStatus(appointmentId, "cancelled");
      updatedMsg = "تم إلغاء الموعد بنجاح ❌";
    } else if (params.action === "no_show") {
      await setAppointmentStatus(appointmentId, "no_show");
      updatedMsg = "تم تسجيل تغيب المريض عن الموعد (لم يحضر) ⚠️";
    } else {
      await setAppointmentStatus(appointmentId, "done");
      updatedMsg = "تم تسجيل إنجاز وإنهاء الموعد بنجاح ✅";
    }

    await recordAudit({
      action: "appointment.update",
      entity: "appointment",
      entityId: String(appointmentId),
      details: { action: params.action, updatedBy: "ai_assistant" },
      actor: context.username || "ai_assistant",
      actorRole: context.role,
    });

    return {
      success: true,
      textSummary: `✅ **تحديث حالة الموعد (#${appointmentId}):**\n${updatedMsg}`,
      cards: [{ title: "حالة الموعد", value: updatedMsg, tone: "good" }],
      actions: [{ label: "عرض جدول المواعيد", href: `/appointments?date=${today}`, actionType: "navigate" }],
    };
  } catch (err) {
    return {
      success: false,
      textSummary: `❌ تعذّر تعديل الموعد: ${(err as Error).message}`,
    };
  }
}

// ─── 4. تسجيل دفعة مالية وسند قبض ─────────────────────────────────────────────

export async function recordPatientPaymentAction(
  params: {
    patientId?: number;
    patientName?: string;
    amount: number | string;
    currency?: Currency;
    method?: "cash" | "transfer";
    invoiceId?: number;
    note?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const role = context.role || context.userRole || "reception";
  if (!canHandleMoney(role)) {
    return {
      success: false,
      textSummary: "🔒 **تنبيه أمني:** تسجيل المقبوضات وسندات الصندوق مقتصر حصراً على موظف الاستقبال أو المدير المالي.",
      warnings: ["صلاحية مالية مفقودة"],
    };
  }

  const currency: Currency = params.currency || "YER";
  const amountMinor = parseAmount(String(params.amount || ""), currency);
  if (!amountMinor || amountMinor <= 0) {
    return {
      success: false,
      textSummary: "❌ يرجى كتابة مبلغ صالح أكبر من الصفر لتسجيل سند القبض.",
    };
  }

  if (!context.isDbConnected) {
    return {
      success: true,
      textSummary: `💵 **[وضع تجريبي] تم تسجيل سند القبض بنجاح:**\n• **المريض:** ${params.patientName || "مريض تجريبي"}\n• **المبلغ:** ${formatMoney(amountMinor, currency)}\n• **طريقة الدفع:** ${params.method === "transfer" ? "تحويل بنكي" : "نقداً بالصندوق"}\n• **رقم السند:** R-DEMO-001`,
      cards: [
        { title: "سند القبض", value: formatMoney(amountMinor, currency), tone: "good" },
        { title: "طريقة القبض", value: params.method === "transfer" ? "تحويل" : "نقد", tone: "info" },
      ],
    };
  }

  try {
    let patientId = params.patientId;
    let patientName = params.patientName || "";

    if (!patientId && params.patientName) {
      const matches = await scopedSearchPatients(params.patientName, 2, context);
      if (matches.length === 1) {
        patientId = matches[0].id;
        patientName = matches[0].fullName;
      } else if (matches.length > 1) {
        return {
          success: false,
          textSummary: `🔍 يوجد أكثر من مريض يطابق «${params.patientName}». يرجى كتابة رقم ملف المريض لتسجيل السند المالي بدقة.`,
        };
      } else {
        return {
          success: false,
          textSummary: `❌ لم يتم العثور على مريض مسجل باسم «${params.patientName}».`,
        };
      }
    } else if (patientId) {
      const p = await getPatient(patientId);
      if (p) patientName = p.fullName;
    }

    if (!patientId) {
      return { success: false, textSummary: "❌ يرجى تحديد المريض لتسجيل القبض المالي." };
    }

    const settings = await getSettings();
    const base = settings["finance.base_currency"];
    if (!isCurrency(base)) {
      return { success: false, textSummary: "العملة الأساسية في المركز غير مضبوطة." };
    }

    const exchangeRate = rateFromSettings(settings, currency, base);
    if (exchangeRate === null) {
      return { success: false, textSummary: "سعر صرف العملة غير مضبوط في إعدادات النظام." };
    }

    const { payment, reason } = await recordPayment({
      patientId,
      invoiceId: params.invoiceId || null,
      kind: "payment",
      amountMinor,
      currency,
      baseCurrency: base,
      exchangeRate,
      method: params.method || "cash",
      note: params.note || "سند قبض مسجل عبر المساعد الذكي",
      createdBy: context.username || "admin",
    });

    if (reason === "no_shift") {
      return {
        success: false,
        textSummary: "⚠️ **تنبيه وردية الصندوق:** لا توجد وردية صندوق مفتوحة حالياً. يرجى فتح الوردية من شاشة الصندوق أولاً لتسجيل أي حركة مالية موثقة.",
        actions: [{ label: "فتح شاشة الصندوق والورديات", href: "/finance/shifts", actionType: "navigate" }],
      };
    }

    if (!payment) {
      return { success: false, textSummary: "❌ تعذّر حفظ سند القبض في قاعدة البيانات." };
    }

    await recordAudit({
      action: "payment.create",
      entity: "payment",
      entityId: String(payment.id),
      entityLabel: payment.receiptNumber,
      details: {
        patientId,
        amount: payment.amountMinor,
        currency: payment.currency,
        recordedBy: "ai_assistant",
      },
      actor: context.username || "admin",
      actorRole: role,
    });

    const cards: KpiCard[] = [
      { title: "سند القبض", value: payment.receiptNumber, tone: "good" },
      { title: "المبلغ المقبوض", value: formatMoney(payment.amountMinor, payment.currency), tone: "good" },
      { title: "المريض", value: patientName, tone: "info" },
    ];

    const actions: ActionButton[] = [
      { label: "عرض كشف حساب المريض", href: `/patients/${patientId}?tab=ledger`, actionType: "navigate" },
      { label: "طباعة سند القبض", href: `/receipts/${payment.id}`, actionType: "navigate" },
    ];

    const textSummary = `✅ **تم بنجاح تسجيل سند القبض المالي وتوريده للصندوق:**\n• **رقم السند:** \`${payment.receiptNumber}\`\n• **المريض:** **${patientName}**\n• **المبلغ:** 💵 **${formatMoney(payment.amountMinor, payment.currency)}** (${payment.method === "transfer" ? "تحويل بنكي" : "نقداً بالصندوق"})\n• **التاريخ:** ${payment.createdAt}\n\nتم تحديث رصيد المريض وإدراجه في كشف الوردية الجارية.`;

    return {
      success: true,
      textSummary,
      cards,
      actions,
      patientIdAccessed: patientId,
      data: payment,
    };
  } catch (err) {
    return {
      success: false,
      textSummary: `❌ تعذّر تسجيل الدفعة: ${(err as Error).message}`,
    };
  }
}

// ─── 5. إضافة تنبيه طبي أو حساسية لمريض ────────────────────────────────────────

export async function addPatientMedicalAlertAction(
  params: {
    patientId?: number;
    patientName?: string;
    medicalAlert: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const alertText = (params.medicalAlert || "").trim();
  if (!alertText) {
    return { success: false, textSummary: "يرجى كتابة نص التنبيه الطبي أو الحساسية." };
  }

  if (!context.isDbConnected) {
    return {
      success: true,
      textSummary: `⚠️ **[وضع تجريبي] تم تسجيل التنبيه الطبي للمريض:**\n«${alertText}»`,
      cards: [{ title: "تنبيه طبي", value: alertText, tone: "warn" }],
    };
  }

  try {
    let patientId = params.patientId;
    let patientName = params.patientName || "";

    if (!patientId && params.patientName) {
      const matches = await scopedSearchPatients(params.patientName, 2, context);
      if (matches.length === 1) {
        patientId = matches[0].id;
        patientName = matches[0].fullName;
      } else {
        return { success: false, textSummary: `لم يتم العثور بدقة على مريض باسم «${params.patientName}».` };
      }
    }

    if (!patientId) {
      return { success: false, textSummary: "يرجى تحديد المريض لتسجيل التنبيه الطبي." };
    }

    const patient = await getPatient(patientId);
    if (!patient) return { success: false, textSummary: "المريض غير موجود." };

    // دمج التنبيه مع القائم إن وجد
    const combinedAlert = patient.medicalAlert
      ? `${patient.medicalAlert} | ${alertText}`
      : alertText;

    await updatePatient(patientId, {
      fullName: patient.fullName,
      phone: patient.phone,
      altPhone: patient.altPhone,
      gender: patient.gender,
      birthYear: patient.birthYear,
      address: patient.address,
      medicalAlert: combinedAlert,
      note: patient.note,
    });

    await recordAudit({
      action: "patient.update",
      entity: "patient",
      entityId: String(patientId),
      entityLabel: patient.fullName,
      details: { newAlert: alertText, fullAlert: combinedAlert },
      actor: context.username || "ai_assistant",
      actorRole: context.role,
    });

    const textSummary = `⚠️ **تم بنجاح تثبيت التنبيه الطبي في ملف المريض «${patient.fullName}»:**\n• **التنبيه الجديد:** **${alertText}**\n• **كامل التنبيهات:** ${combinedAlert}\n\nيظهر هذا التنبيه بشكل بارز للطبيب في كل زيارة وفي ترويسة الملف السريري لسلامة المريض.`;

    return {
      success: true,
      textSummary,
      cards: [
        { title: "المريض", value: patient.fullName, tone: "info" },
        { title: "⚠️ تنبيه طبي معتمد", value: alertText, tone: "warn" },
      ],
      actions: [{ label: "فتح ملف المريض", href: `/patients/${patientId}`, actionType: "navigate" }],
      patientIdAccessed: patientId,
    };
  } catch (err) {
    return {
      success: false,
      textSummary: `❌ تعذّر تحديث التنبيه الطبي: ${(err as Error).message}`,
    };
  }
}

// ─── 6. إنشاء أمر معمل جديد ───────────────────────────────────────────────────

export async function createLabOrderAction(
  params: {
    patientId?: number;
    patientName?: string;
    labName?: string;
    serviceName?: string;
    shade?: string;
    dueDate?: string;
    note?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const today = context.todayISO || clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const defaultDue = addDays(today, 5);
  const dueDate = params.dueDate || defaultDue;

  if (!context.isDbConnected) {
    return {
      success: true,
      textSummary: `🦷 **[وضع تجريبي] تم إنشاء طلب المعمل بنجاح:**\n• **المريض:** ${params.patientName || "مريض تجريبي"}\n• **المعمل:** ${params.labName || "معمل الأسنان المعتمد"}\n• **الخدمة:** ${params.serviceName || "تاج زيركون"}\n• **اللون:** ${params.shade || "A2"}\n• **تاريخ التسليم:** ${dueDate}`,
      cards: [{ title: "أمر المعمل", value: "قيد الإنجاز ⏳", tone: "info" }],
      actions: [{ label: "فتح سجل المعمل", href: "/lab", actionType: "navigate" }],
    };
  }

  try {
    let patientId = params.patientId;
    let patientName = params.patientName || "";

    if (!patientId && params.patientName) {
      const matches = await scopedSearchPatients(params.patientName, 2, context);
      if (matches.length === 1) {
        patientId = matches[0].id;
        patientName = matches[0].fullName;
      }
    } else if (patientId) {
      const p = await getPatient(patientId);
      if (p) patientName = p.fullName;
    }

    if (!patientId) {
      return { success: false, textSummary: "❌ يرجى تحديد المريض لإنشاء طلب المعمل." };
    }

    // المعمل الافتراضي
    const labs = await listLabNames().catch(() => []);
    const defaultLab = labs[0];
    const labName = params.labName || defaultLab?.labName || "المعمل المركزي";
    const labPhone = defaultLab?.labPhone ?? null;

    const settings = await getSettings();
    const base = (isCurrency(settings["finance.base_currency"]) ? settings["finance.base_currency"] : "YER") as Currency;
    const exchangeRate = rateFromSettings(settings, "YER", base) ?? 1;

    const order = await createLabOrder({
      patientId,
      labName,
      labPhone,
      workType: params.serviceName || "تركيبات / تعويضات سنية",
      details: `اللون: ${params.shade || "A2"}`,
      sentDate: today,
      dueDate,
      note: params.note || "طلب معمل مسجل عبر المساعد الذكي",
      partyId: null,
      costMinor: null,
      costCurrency: base,
      baseCurrency: base,
      exchangeRate,
      createdBy: context.username || "ai_assistant",
      shade: params.shade || "A2",
      doctorId: context.doctorPartyId || null,
    });

    if (!order) {
      return {
        success: false,
        textSummary: "❌ تعذّر حفظ أمر المعمل في قاعدة البيانات.",
      };
    }

    await recordAudit({
      action: "lab_order.create",
      entity: "lab_order",
      entityId: String(order.id),
      entityLabel: `أمر معمل: ${patientName} (${labName})`,
      details: { service: params.serviceName, shade: params.shade, dueDate },
      actor: context.username || "ai_assistant",
      actorRole: context.role,
    });

    const textSummary = `🦷 **تم بنجاح تسجيل أمر المعمل وإرساله لقائمة المتابعة:**\n• **المريض:** **${patientName}**\n• **المعمل:** **${labName}**\n• **الخدمة:** ${params.serviceName || "تركيبات"}\n• **اللون (VITA):** \`${params.shade || "A2"}\`\n• **تاريخ الاستلام المطلوب:** 📅 **${dueDate}**\n\nتتم متابعة حالة الإنجاز والتسليم عبر قسم المعامل.`;

    return {
      success: true,
      textSummary,
      cards: [
        { title: "حالة الطلب", value: "مرسل للمعمل ⏳", tone: "info" },
        { title: "المعمل", value: labName, tone: "calm" },
        { title: "تاريخ الاستلام", value: dueDate, tone: "info" },
      ],
      actions: [
        { label: "فتح سجل المعامل", href: "/lab", actionType: "navigate" },
        { label: `ملف المريض ${patientName}`, href: `/patients/${patientId}`, actionType: "navigate" },
      ],
      patientIdAccessed: patientId,
      data: order,
    };
  } catch (err) {
    return {
      success: false,
      textSummary: `❌ تعذّر إنشاء طلب المعمل: ${(err as Error).message}`,
    };
  }
}

// ─── 7. تسجيل حركة مخزون (إدخال / صرف) ────────────────────────────────────────

export async function recordInventoryMovementAction(
  params: {
    itemName?: string;
    itemId?: number;
    kind: "in" | "out" | "adjust";
    qty: number;
    reason?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const role = context.role || context.userRole || "reception";
  if (params.kind !== "out" && !canManageInventory(role)) {
    return {
      success: false,
      textSummary: "🔒 **تنبيه أمني:** إدخال الوارد وتسوية المخزون مقتصرة على الإدارة والاستقبال.",
      warnings: ["صلاحية مخزون مفقودة"],
    };
  }

  const qty = Number(params.qty);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { success: false, textSummary: "❌ يرجى كتابة كمية صحيحة أكبر من صفر." };
  }

  if (!context.isDbConnected) {
    return {
      success: true,
      textSummary: `📦 **[وضع تجريبي] تم تسجيل حركة المخزون:**\n• **البند:** ${params.itemName || "مادة سنية"}\n• **النوع:** ${params.kind === "in" ? "إدخال وارد" : "صرف واستهلاك"}\n• **الكمية:** ${qty}`,
      cards: [{ title: "حركة المخزون", value: `${qty} وحدة`, tone: "good" }],
      actions: [{ label: "فتح شاشة المخزون", href: "/inventory", actionType: "navigate" }],
    };
  }

  try {
    const items = await listInventoryItems();
    let targetItem = items.find((i) => i.id === params.itemId);

    if (!targetItem && params.itemName) {
      targetItem = items.find((i) => i.name.toLowerCase().includes(params.itemName!.toLowerCase().trim()));
    }

    if (!targetItem) {
      return {
        success: false,
        textSummary: `❌ لم أجد مادة في المخزون تطابق «${params.itemName || params.itemId}». الأرصدة المتوفرة:\n${items.slice(0, 5).map((i) => `• ${i.name} (رصيد: ${i.balance} ${i.unit})`).join("\n")}`,
      };
    }

    const movementRes = await createInventoryMovement({
      itemId: targetItem.id,
      kind: params.kind,
      qty,
      reason: params.reason || (params.kind === "in" ? "توريد عبر المساعد الذكي" : "استهلاك عيادة"),
      createdBy: context.username || "admin",
    });

    if (!movementRes.ok) {
      return {
        success: false,
        textSummary: `❌ تعذّر تسجيل حركة المخزون: ${movementRes.message}`,
      };
    }

    await recordAudit({
      action: "inventory.move",
      entity: "inventory_item",
      entityId: String(targetItem.id),
      entityLabel: targetItem.name,
      details: { qty, kind: params.kind, reason: params.reason },
      actor: context.username || "admin",
      actorRole: role,
    });

    const kindLabel = params.kind === "in" ? "إدخال وتوريد 📥" : params.kind === "out" ? "صرف واستهلاك 📤" : "تسوية جرد ⚖️";
    const textSummary = `📦 **تم بنجاح تسجيل حركة المخزون:**\n• **المادة:** **${targetItem.name}**\n• **نوع الحركة:** **${kindLabel}**\n• **الكمية:** **${qty} ${targetItem.unit}**\n• **السبب:** ${params.reason || "توثيق عيادة"}\n\nتم تحديث رصيد البند في سجلات المخزون فوراً.`;

    return {
      success: true,
      textSummary,
      cards: [
        { title: targetItem.name, value: `${qty} ${targetItem.unit}`, tone: "info" },
        { title: "نوع الحركة", value: kindLabel, tone: "good" },
      ],
      actions: [{ label: "فتح شاشة المخزون", href: "/inventory", actionType: "navigate" }],
      data: movementRes.movement,
    };
  } catch (err) {
    return {
      success: false,
      textSummary: `❌ تعذّر تسجيل حركة المخزون: ${(err as Error).message}`,
    };
  }
}

// ─── 8. توليد رسالة واتساب مباشرة للمريض ───────────────────────────────────────

export async function generateWhatsAppReminderAction(
  params: {
    patientId?: number;
    patientName?: string;
    type?: "appointment" | "balance_due" | "postop" | "custom";
    customText?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const today = context.todayISO || clinicDateString(new Date(), CLINIC_TIME_ZONE);

  let patientPhone = "";
  let patientName = params.patientName || "المريض الكريم";
  let balanceMinor = 0;

  if (context.isDbConnected && (params.patientId || params.patientName)) {
    let p = null;
    if (params.patientId) {
      p = await getPatient(params.patientId);
    } else if (params.patientName) {
      const matches = await scopedSearchPatients(params.patientName, 1, context);
      if (matches[0]) p = await getPatient(matches[0].id);
    }
    if (p) {
      patientName = p.fullName;
      patientPhone = p.phone || "";
    }
  }

  let text = "";
  const type = params.type || "appointment";

  if (type === "appointment") {
    text = `السلام عليكم ورحمة الله وبركاته يا ${patientName}،
نود تذكيركم بموعدكم القادم في «مركز الدكتور عقلان الكامل لطب وجراحة وتقويم الأسنان».
نرجو التكرم بالحضور قبل الموعد بـ 10 دقائق لضمان راحتكم وسرعة خدمتكم.
نتمنى لكم دوام الصحة والعافية. 🦷✨`;
  } else if (type === "balance_due") {
    text = `السلام عليكم ورحمة الله وبركاته أخي/أختي ${patientName}،
تحية طيبة من «مركز الدكتور عقلan لطب وتقويم الأسنان».
نود إحاطتكم بضرورة مراجعة قسم الحسابات بالمركز لاستكمال المتبقي من خطتكم العلاجية.
شاكرين لكم حسن تعاونكم الدائم معنا. 🌸`;
  } else if (type === "postop") {
    text = `السلام عليكم ${patientName}،
إرشادات ما بعد العلاج من د. عقلان الكامل:
1. العض على الشاش لمدة ساعة كاملة وتجنب البصق.
2. الامتناع عن المشروبات الساخنة والتدخين اليوم.
3. تناول العلاج والمسكن وفق وصفة الطبيب بدقة.
سلامتكم وألف لا بأس عليكم. 🌹`;
  } else {
    text = params.customText || `مرحباً ${patientName}، تواصل من عيادة الدكتور عقلان الكامل.`;
  }

  const cleanPhone = toWhatsAppNumber(patientPhone);
  const waLink = cleanPhone ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(text)}` : null;

  const actions: ActionButton[] = [];
  if (waLink) {
    actions.push({
      label: `📲 إرسال عبر واتساب إلى ${patientName}`,
      href: waLink,
      actionType: "whatsapp",
    });
  }

  const textSummary = `📱 **تم تجهيز رسالة الواتساب المعتمدة لـ «${patientName}»:**\n\n\`\`\`text\n${text}\n\`\`\`${
    waLink ? `\n👉 اضغط على الزر أدناه لفتح الواتساب والإرسال الفوري للرقم (${patientPhone}).` : "\n⚠️ رقم هاتف المريض غير مسجل في الملف لإرسال الرابط المباشر."
  }`;

  return {
    success: true,
    textSummary,
    cards: [
      { title: "المريض", value: patientName, tone: "info" },
      { title: "حالة الرسالة", value: cleanPhone ? "جاهزة للإرسال 📲" : "بلا رقم هاتف", tone: cleanPhone ? "good" : "warn" },
    ],
    actions,
  };
}
