/**
 * مطابقة وتسوية كشوف حسابات المختبرات السنية — المنطق الخالص.
 *
 * يعالج مطابقة الفاتورة الشهرية أو الكشف المالي الذي يرسله فني المختبر مع
 * أوامر النظام المسجلة، واكتشاف أي فروقات سعرية، وإصدار سند صرف مجمع يسدد
 * الحساب ويوثق المطابقة.
 *
 * كما يتضمن محرك الكشف الاستباقي عن تضارب مواعيد المرضى القادمة مع أعمال
 * المعمل التي لم تصل بعد إلى المركز.
 */

import type { Currency } from "./money";
import type { LabOrder } from "./lab";
import type { Appointment } from "./schedule";

export interface ReconcileOrderItem {
  orderId: number;
  patientName: string;
  patientNumber?: string | null;
  workType: string;
  teeth?: string | null;
  sentDate: string;
  dueDate: string;
  systemCostMinor: number;
  claimedCostMinor?: number; // ما يطالب به الفني إن اختلف
  currency: Currency;
  status: string;
  financialStatus: string;
  notes?: string | null;
}

export interface ReconcileResult {
  partyId: number;
  partyName: string;
  currency: Currency;
  selectedOrderIds: number[];
  totalOrdersCount: number;
  totalSystemCostMinor: number;
  totalClaimedCostMinor: number;
  varianceMinor: number; // الفرق (المطالَب به - المسجل بالنظام)
  hasDiscrepancy: boolean;
  discrepancies: {
    orderId: number;
    patientName: string;
    workType: string;
    systemCostMinor: number;
    claimedCostMinor: number;
    diffMinor: number;
  }[];
}

export function reconcileLabStatement(input: {
  partyId: number;
  partyName: string;
  currency: Currency;
  items: ReconcileOrderItem[];
  selectedIds: number[];
  customClaimedCosts?: Record<number, number>; // orderId -> claimedMinor
}): ReconcileResult {
  const selectedSet = new Set(input.selectedIds);
  const selectedItems = input.items.filter((item) => selectedSet.has(item.orderId));

  let totalSystemCostMinor = 0;
  let totalClaimedCostMinor = 0;
  const discrepancies: ReconcileResult["discrepancies"] = [];

  for (const item of selectedItems) {
    const sysCost = Math.max(0, item.systemCostMinor || 0);
    const claimedCost =
      input.customClaimedCosts && input.customClaimedCosts[item.orderId] !== undefined
        ? Math.max(0, input.customClaimedCosts[item.orderId]!)
        : item.claimedCostMinor !== undefined
        ? Math.max(0, item.claimedCostMinor)
        : sysCost;

    totalSystemCostMinor += sysCost;
    totalClaimedCostMinor += claimedCost;

    if (claimedCost !== sysCost) {
      discrepancies.push({
        orderId: item.orderId,
        patientName: item.patientName,
        workType: item.workType,
        systemCostMinor: sysCost,
        claimedCostMinor: claimedCost,
        diffMinor: claimedCost - sysCost,
      });
    }
  }

  const varianceMinor = totalClaimedCostMinor - totalSystemCostMinor;

  return {
    partyId: input.partyId,
    partyName: input.partyName,
    currency: input.currency,
    selectedOrderIds: input.selectedIds,
    totalOrdersCount: selectedItems.length,
    totalSystemCostMinor,
    totalClaimedCostMinor,
    varianceMinor,
    hasDiscrepancy: discrepancies.length > 0,
    discrepancies,
  };
}

/**
 * يولد نص البيان لسند الصرف المجمع وسجل التدقيق.
 */
export function buildBatchSettlementNote(
  partyName: string,
  reconcileResult: ReconcileResult,
  monthLabel?: string,
): string {
  const count = reconcileResult.totalOrdersCount;
  const orderList = reconcileResult.selectedOrderIds.map((id) => `RX-${id}`).join(", ");
  const monthText = monthLabel ? ` لشهر (${monthLabel})` : "";

  let note = `تسوية وسداد كشف حساب مختبر [${partyName}]${monthText} لعدد (${count}) أوامر تركيبات: [${orderList}]`;

  if (reconcileResult.hasDiscrepancy) {
    note += ` | فارق تسوية معتمد: ${reconcileResult.varianceMinor > 0 ? "+" : ""}${reconcileResult.varianceMinor}`;
  }

  return note;
}

// ─── محرك الإنذار المبكر لمواعيد المرضى وأعمال المختبر ──────────────────────────

export interface LabDeliveryRisk {
  patientId: number;
  patientName: string;
  patientPhone: string | null;
  appointmentId: number;
  appointmentDate: string; // YYYY-MM-DD
  appointmentTime: string; // HH:MM
  doctorName?: string | null;
  labOrderId: number;
  workType: string;
  labName: string;
  labPhone: string | null;
  dueDate: string;
  status: string; // 'needed' | 'sent' | 'in_progress'
  riskLevel: "critical" | "warning";
  riskMessage: string;
}

/**
 * يكتشف أي مواعيد حضور للمرضى اليوم أو خلال الـ 48 ساعة القادمة ولديهم أعمال معمل
 * لم تُستلم في العيادة بعد (`received` أو `delivered`).
 */
export function detectLabAppointmentMismatches(
  appointments: Appointment[],
  labOrders: LabOrder[],
  todayStr: string,
): LabDeliveryRisk[] {
  const risks: LabDeliveryRisk[] = [];

  // الأوامر التي لم تصل بعد إلى العيادة
  const undeliveredOrders = labOrders.filter(
    (o) => o.status === "needed" || o.status === "sent" || o.status === "in_progress",
  );

  if (undeliveredOrders.length === 0) return risks;

  // مواعيد اليوم والمستقبل القريب (خلال يومين)
  const relevantAppointments = appointments.filter((a) => {
    if (a.status !== "booked" && a.status !== "arrived") return false;
    return a.scheduledDate >= todayStr;
  });

  for (const appt of relevantAppointments) {
    const matchingOrder = undeliveredOrders.find((o) => o.patientId === appt.patientId);
    if (!matchingOrder) continue;

    const isToday = appt.scheduledDate === todayStr;

    const riskLevel: "critical" | "warning" = isToday ? "critical" : "warning";
    const timingText = isToday
      ? `اليوم في تمام الساعة (${appt.scheduledTime})`
      : `قريباً بتاريخ (${appt.scheduledDate} - ${appt.scheduledTime})`;

    const patientName = appt.patientName;
    const patientPhone = appt.patientPhone;

    const riskMessage = isToday
      ? `🚨 خطر حرج: المريض [${patientName}] لديه موعد ${timingText}، ولكن تركيبة الأسنان (${matchingOrder.workType}) لا تزال في ${matchingOrder.labName} ولم تُستلم بالعيادة!`
      : `⚠️ تنبيه استباقي: المريض [${patientName}] لديه موعد ${timingText}، وأمر المعمل (${matchingOrder.workType}) ما زال قيد الإنجاز في ${matchingOrder.labName}.`;

    risks.push({
      patientId: appt.patientId,
      patientName,
      patientPhone,
      appointmentId: appt.id,
      appointmentDate: appt.scheduledDate,
      appointmentTime: appt.scheduledTime,
      doctorName: matchingOrder.doctorName,
      labOrderId: matchingOrder.id,
      workType: matchingOrder.workType,
      labName: matchingOrder.labName,
      labPhone: matchingOrder.labPhone,
      dueDate: matchingOrder.dueDate,
      status: matchingOrder.status,
      riskLevel,
      riskMessage,
    });
  }

  // ترتيب الحالات الحرجة أولاً
  return risks.sort((a, b) => (a.riskLevel === "critical" ? -1 : 1));
}
