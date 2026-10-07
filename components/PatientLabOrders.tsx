"use client";

import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatMoney, type Currency } from "@/lib/money";
import { friendlyDate, friendlyDateLong } from "@/lib/reminders";
import {
  type LabOrder,
  LAB_TOOTH_ROLE_META,
  parseLabTeeth,
  LAB_PRIORITY_LABEL,
  WORK_TYPES,
} from "@/lib/lab";
import { LabDentalChart } from "./LabDentalChart";
import { LabPrescriptionModal } from "./LabPrescriptionModal";
import { LabDeliveryAppointmentModal } from "./LabDeliveryAppointmentModal";
import { useClinicName, useSetting } from "./SettingsProvider";
import { useSession } from "./SessionProvider";
import { isAdmin } from "@/lib/roles";

const STATUS_MAP: Record<string, { label: string; bg: string; text: string }> = {
  needed: { label: "لم يُرسل بعد — من إجراء الزيارة", bg: "bg-sky-50 border-sky-200", text: "text-sky-700" },
  sent: { label: "قيد العمل بالمختبر", bg: "bg-amber-50 border-amber-200", text: "text-amber-700" },
  in_progress: { label: "قيد التصنيع في المعمل", bg: "bg-violet-50 border-violet-200", text: "text-violet-700" },
  received: { label: "مستلم بالعيادة", bg: "bg-blue-50 border-blue-200", text: "text-blue-700" },
  delivered: { label: "تم التسليم للمريض", bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700" },
  remake: { label: "إعادة تصنيع", bg: "bg-red-50 border-red-200", text: "text-red-700" },
  cancelled: { label: "ملغى", bg: "bg-slate-50 border-slate-200", text: "text-slate-500" },
};

type LabReadOwner = { active: boolean; sequence: number; controller: AbortController | null };
type LabName = { labName: string; labPhone: string | null };
type LabReadState =
  | { owner: LabReadOwner; status: "loading" }
  | { owner: LabReadOwner; status: "error"; message: string }
  | { owner: LabReadOwner; status: "success"; orders: LabOrder[]; labs: LabName[] };
type OwnedOrder = { owner: LabReadOwner; order: LabOrder };
const READ_ERROR = "تعذّر تحميل طلبات المعمل. أعد المحاولة.";

const initialSentDate = () => clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
const initialDueDate = () => {
  const date = new Date();
  date.setDate(date.getDate() + 5);
  return date.toISOString().slice(0, 10);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Check list identity and renderable fields; this is not an exhaustive LabOrder schema. */
function isPatientLabList(value: unknown, patientId: number): value is { orders: LabOrder[]; labs: LabName[] } {
  if (!isRecord(value) || !Array.isArray(value.orders) || !Array.isArray(value.labs)) return false;
  const ids = new Set<number>();
  const ordersValid = value.orders.every((order: unknown) => {
    if (!isRecord(order) || typeof order.id !== "number" || !Number.isSafeInteger(order.id) || order.id <= 0
      || ids.has(order.id) || order.patientId !== patientId
      || !["patientName", "labName", "workType", "sentDate", "dueDate"].every((key) => typeof order[key] === "string")
      || typeof order.status !== "string" || !Object.hasOwn(STATUS_MAP, order.status)
      || !["patientNumber", "patientPhone", "labPhone", "details", "toothNumbers", "shade", "stumpShade",
        "doctorName", "qualityNotes", "remakeReason", "technicianName", "note"].every(
        (key) => order[key] == null || typeof order[key] === "string",
      )
      || !["costMinor", "baseAmountMinor"].every(
        (key) => order[key] == null || (typeof order[key] === "number" && Number.isFinite(order[key])),
      )) return false;
    ids.add(order.id);
    return true;
  });
  return ordersValid && value.labs.every((lab: unknown) =>
    isRecord(lab) && typeof lab.labName === "string" && (lab.labPhone === null || typeof lab.labPhone === "string"));
}

export function PatientLabOrders({
  patientId,
  patientName,
  base = "YER",
}: {
  patientId: number;
  patientName: string;
  base?: Currency;
}) {
  const clinicName = useClinicName();
  const clinicPhone = useSetting("clinic.phone");
  const session = useSession();
  const admin = isAdmin(session?.role);

  // Match the patient workspace's principal scope without using object identity.
  const scope = JSON.stringify([patientId, session?.username, session?.role, session?.permissions ?? null]);
  const hasPrincipal = !!session?.username && !!session?.role;
  const hasContext = hasPrincipal && Number.isSafeInteger(patientId) && patientId > 0;
  const owner = useMemo<LabReadOwner>(() => ({ active: false, sequence: 0, controller: null }), [scope]);
  const [readState, setReadState] = useState<LabReadState | null>(null);
  const currentRead = readState?.owner === owner ? readState : null;
  const loading = !currentRead || currentRead.status === "loading";
  const orders = currentRead?.status === "success" ? currentRead.orders : [];
  const labs = currentRead?.status === "success" ? currentRead.labs : [];
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep a refused status command visible even if an unrelated read finishes.
  const [statusError, setStatusError] = useState<string | null>(null);
  const mutationPending = useRef(false);

  // حقول الإضافة
  const [labName, setLabName] = useState("");
  const [workType, setWorkType] = useState(WORK_TYPES[0]);
  const [customWork, setCustomWork] = useState("");
  const [toothNumbers, setToothNumbers] = useState("");
  const [shade, setShade] = useState("");
  const [priority, setPriority] = useState<"normal" | "urgent" | "rush">("normal");
  const [details, setDetails] = useState("");
  const [showChart, setShowChart] = useState(false);
  const [sentDate, setSentDate] = useState(initialSentDate);
  const [dueDate, setDueDate] = useState(initialDueDate);
  const [cost, setCost] = useState("");
  const [note, setNote] = useState("");
  /* المختبرات المسجّلة (جهات المختبر): التكلفة لا تُسجّل إلا على جهة، وإلا رفضها
     الخادم — فكان حقل التكلفة هنا يفشل دائمًا بلا جهة. */
  const [registeredLabs, setRegisteredLabs] = useState<{ id: number; name: string }[]>([]);
  const [prescriptionSelection, setPrescriptionSelection] = useState<OwnedOrder | null>(null);
  const [deliverySelection, setDeliverySelection] = useState<OwnedOrder | null>(null);
  const prescriptionOrder = prescriptionSelection?.owner === owner ? prescriptionSelection.order : null;
  const deliveryAppointmentOrder = deliverySelection?.owner === owner ? deliverySelection.order : null;
  const setPrescriptionOrder = (order: LabOrder | null) => {
    if (owner.active) setPrescriptionSelection(order ? { owner, order } : null);
  };
  const setDeliveryAppointmentOrder = (order: LabOrder | null) => {
    if (owner.active) setDeliverySelection(order ? { owner, order } : null);
  };

  useLayoutEffect(() => {
    owner.active = hasContext;
    if (!hasContext) setReadState({ owner, status: "error", message: hasPrincipal
      ? "تعذّر التحقق من سياق المريض."
      : "انتهت الجلسة. سجّل الدخول من جديد." });
    mutationPending.current = false;
    setBusy(false);
    setError(null);
    setStatusError(null);
    setShowAdd(false);
    setPrescriptionSelection(null);
    setDeliverySelection(null);
    setRegisteredLabs([]);
    // A reused instance must not carry a patient-specific draft into its new scope.
    setLabName("");
    setWorkType(WORK_TYPES[0]);
    setCustomWork("");
    setToothNumbers("");
    setShade("");
    setPriority("normal");
    setDetails("");
    setShowChart(false);
    setSentDate(initialSentDate());
    setDueDate(initialDueDate());
    setCost("");
    setNote("");
    return () => {
      owner.active = false;
      ++owner.sequence;
      owner.controller?.abort();
      owner.controller = null;
    };
  }, [owner, hasContext, hasPrincipal]);

  const load = useCallback(async () => {
    if (!owner.active) return;
    const sequence = ++owner.sequence;
    owner.controller?.abort();
    const controller = new AbortController();
    owner.controller = controller;
    const current = () => owner.active && owner.sequence === sequence && !controller.signal.aborted;
    setReadState({ owner, status: "loading" });
    try {
      const res = await fetch(`/api/lab?patientId=${patientId}`, { cache: "no-store", signal: controller.signal });
      if (!current()) return;
      if (!res.ok) {
        // Failure of the scoped endpoint is not permission to request all orders.
        setReadState({ owner, status: "error", message: READ_ERROR });
        return;
      }
      const data: unknown = await res.json();
      if (!current()) return;
      if (!isPatientLabList(data, patientId)) {
        setReadState({ owner, status: "error", message: READ_ERROR });
        return;
      }
      setReadState({ owner, status: "success", orders: data.orders, labs: data.labs });
    } catch {
      if (current()) setReadState({ owner, status: "error", message: READ_ERROR });
    } finally {
      if (current()) owner.controller = null;
    }
  }, [owner, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  // تحميل المختبرات المسجلة لربط التكلفة بجهتها
  useEffect(() => {
    if (!owner.active) return;
    const controller = new AbortController();
    const current = () => owner.active && !controller.signal.aborted;
    void (async () => {
      try {
        const res = await fetch("/api/laboratories", { cache: "no-store", signal: controller.signal });
        if (!current() || !res.ok) return;
        const data: unknown = await res.json();
        if (!current() || !isRecord(data) || !Array.isArray(data.laboratories)) return;
        const list = data.laboratories;
        if (!list.every((lab: unknown) => isRecord(lab) && typeof lab.id === "number"
          && Number.isSafeInteger(lab.id) && lab.id > 0 && typeof lab.name === "string")) return;
        setRegisteredLabs(list.filter((lab) => lab.isActive !== false).map((lab) => ({ id: lab.id, name: lab.name })));
      } catch {
        /* تجاهل — تبقى التكلفة بلا ربط ويرفضها الخادم برسالة واضحة */
      }
    })();
    return () => controller.abort();
  }, [owner]);

  const submitOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!owner.active || !labName.trim() || busy || mutationPending.current) return;
    setStatusError(null);

    /* التكلفة التزام على جهة مسجلة: نطابق اسم المختبر المكتوب مع المختبرات
       المسجلة؛ فإن لم يوجد فالتكلفة تُترك للمالية من لوحة أعمال المختبر. */
    const wantsCost = cost.trim() !== "";
    const matchedParty = wantsCost
      ? registeredLabs.find((l) => l.name.trim() === labName.trim())
      : undefined;
    if (wantsCost && !matchedParty) {
      setError("تسجيل التكلفة يتطلب اختيار مختبر مسجّل — اكتب اسمه كما هو في شاشة المختبرات، أو أفرغ خانة التكلفة وسجّلها لاحقًا من لوحة أعمال المختبر.");
      return;
    }

    mutationPending.current = true;
    setBusy(true);
    setError(null);

    const finalWork = workType === "أخرى (مخصص)" ? customWork.trim() || "عمل معمل مخصص" : workType;

    try {
      const res = await fetch("/api/lab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId,
          labName: labName.trim(),
          workType: finalWork,
          toothNumbers: toothNumbers.trim() || undefined,
          shade: shade.trim() || undefined,
          priority,
          details: details.trim() || null,
          sentDate,
          dueDate,
          cost: wantsCost ? cost.trim() : undefined,
          costCurrency: wantsCost ? base : undefined,
          partyId: matchedParty ? matchedParty.id : undefined,
          note: note.trim() || null,
        }),
      });
      if (!owner.active) return;
      const data = await res.json().catch(() => null);
      if (!owner.active) return;
      if (!res.ok) {
        setError(data?.message ?? "تعذّر حفظ طلب المعمل.");
        return;
      }
      setShowAdd(false);
      setToothNumbers("");
      setShade("");
      setDetails("");
      setCost("");
      setNote("");
      await load();
    } catch {
      if (owner.active) setError("تعذّر الاتصال بالخادم.");
    } finally {
      if (owner.active) {
        mutationPending.current = false;
        setBusy(false);
      }
    }
  };

  const updateStatus = async (orderId: number, nextStatus: "received" | "delivered") => {
    if (!owner.active || busy || mutationPending.current) return;
    const target = orders.find((order) => order.id === orderId && order.patientId === patientId);
    if (!target) return;
    mutationPending.current = true;
    setBusy(true);
    setStatusError(null);
    try {
      const res = await fetch(`/api/lab/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!owner.active) return;
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (!owner.active) return;
        const message = typeof data?.message === "string" && data.message.trim()
          ? data.message
          : "تعذّر تحديث حالة طلب المعمل.";
        // The API's existing conflict text claims a refresh that did not happen.
        setStatusError(res.status === 409 && message === "حالة العمل تغيّرت من جهاز آخر. حدّثت القائمة — راجعها."
          ? "حالة العمل تغيّرت من جهاز آخر. أعد تحميل القائمة وراجعها قبل إعادة المحاولة."
          : message);
        return;
      }
      await load();
      if (owner.active && nextStatus === "received") {
        setDeliveryAppointmentOrder({ ...target, status: "received" });
      }
    } catch {
      // A lost response does not establish whether the server committed.
      if (owner.active) setStatusError("تعذّر تأكيد تحديث حالة طلب المعمل. تحقّق من حالته قبل إعادة المحاولة.");
    } finally {
      if (owner.active) {
        mutationPending.current = false;
        setBusy(false);
      }
    }
  };

  /* إلغاء إرسالية قائمة عند المختبر — من ملف المريض، والمدير وحده: الخادم يحرس
   * البوابة نفسها (رسالة واضحة لغيره)، والزر لا يظهر له أصلًا. */
  const cancelSubmission = async (order: LabOrder) => {
    if (!owner.active || busy || mutationPending.current) return;
    const hasCost = Number(order.costMinor) > 0;
    const message = hasCost
      ? `إلغاء إرسالية «${order.workType}» إلى «${order.labName}»؟\nالتزامها غير المسدَّد يُمحى معها. إن كان مسدَّدًا بسند صرف يبقى أثره المالي للتدقيق.`
      : `إلغاء إرسالية «${order.workType}» إلى «${order.labName}»؟`;
    if (!window.confirm(message)) return;
    mutationPending.current = true;
    setBusy(true);
    setStatusError(null);
    setError(null);
    try {
      const res = await fetch(`/api/lab/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled", note: "إلغاء من ملف المريض" }),
      });
      if (!owner.active) return;
      const data = await res.json().catch(() => null);
      if (!owner.active) return;
      if (!res.ok) {
        setError(data?.message ?? "تعذّر إلغاء الإرسالية.");
        return;
      }
      await load();
    } catch {
      if (owner.active) setError("تعذّر الاتصال بالخادم.");
    } finally {
      if (owner.active) {
        mutationPending.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-navy-900">أعمال وتركيبات المعمل{currentRead?.status === "success" ? ` (${orders.length})` : ""}</h3>
          <p className="text-xs text-slate-500">متابعة التركيبات والتيجان والأطقم للمريض وتاريخ استلامها</p>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(!showAdd)}
          disabled={!hasContext}
          className="rounded-xl bg-navy-800 px-3.5 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90"
        >
          {showAdd ? "إلغاء" : "+ طلب معمل جديد"}
        </button>
      </div>

      {statusError || error ? (
        <div role="alert" className="min-w-0 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700 [overflow-wrap:anywhere]">{statusError ?? error}</div>
      ) : null}

      {showAdd ? (
        <form onSubmit={submitOrder} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-3">
          <h4 className="text-xs font-bold text-navy-900">إرسال عمل جديد إلى المختبر</h4>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-600">اسم المختبر *</span>
              <input
                value={labName}
                onChange={(e) => setLabName(e.target.value)}
                placeholder="مثال: مختبر السعادة للأسنان"
                list="patient-labs-list"
                required
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
              <datalist id="patient-labs-list">
                {[...registeredLabs.map((l) => l.name), ...labs.map((l) => l.labName)].map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>

            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-600">نوع العمل / التركيبة *</span>
              <select
                value={workType}
                onChange={(e) => setWorkType(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
              >
                {WORK_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            {workType === "أخرى (مخصص)" ? (
              <label className="text-xs sm:col-span-2">
                <span className="mb-1 block font-bold text-slate-600">حدد نوع العمل بدقة</span>
                <input
                  value={customWork}
                  onChange={(e) => setCustomWork(e.target.value)}
                  placeholder="وصف العمل المطلوب من المعمل"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
                />
              </label>
            ) : null}

            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-600">تاريخ الإرسال</span>
              <input
                type="date"
                value={sentDate}
                onChange={(e) => setSentDate(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
              />
            </label>

            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-600">موعد التسليم المتوقع *</span>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                required
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
              />
            </label>

            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-600">اللون وتدرج الظل</span>
              <input
                value={shade}
                onChange={(e) => setShade(e.target.value)}
                placeholder="مثال: A2 أو A3.5 أو BL2"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
              />
            </label>

            <label className="text-xs">
              <span className="mb-1 block font-bold text-slate-600">درجة الأهمية</span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as typeof priority)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
              >
                <option value="normal">عادي</option>
                <option value="urgent">مستعجل</option>
                <option value="rush">طارئ فوري</option>
              </select>
            </label>

            {/* FDI Dental Chart Section */}
            <div className="col-span-full rounded-2xl border border-slate-200 bg-white p-3 shadow-2xs">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-navy-900 flex items-center gap-1.5">
                  <span>🦷</span>
                  <span>تحديد الأسنان والأدوار بمخطط FDI التفاعلي</span>
                </span>
                <button
                  type="button"
                  onClick={() => setShowChart((p) => !p)}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-bold text-navy-900 hover:bg-slate-100"
                >
                  {showChart ? "إخفاء المخطط ▲" : "عرض مخطط الأسنان ▼"}
                </button>
              </div>

              {showChart && (
                <div className="mt-2">
                  <LabDentalChart
                    value={toothNumbers}
                    onChange={(val) => setToothNumbers(val)}
                    showSummary={true}
                  />
                </div>
              )}

              <div className="mt-2">
                <span className="mb-1 block text-[10px] font-bold text-slate-400">نص الأسنان المحددة:</span>
                <input
                  value={toothNumbers}
                  onChange={(e) => setToothNumbers(e.target.value)}
                  placeholder="مثال: 14(Abutment), 15(Pontic), 16(Abutment)"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-mono"
                />
              </div>
            </div>

            <label className="text-xs sm:col-span-2">
              <span className="mb-1 block font-bold text-slate-600">المواصفات والتعليمات الفنية</span>
              <input
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder="مثال: تشريح عالي، مع دعامة مخصصة، إطباق خفيف..."
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
              />
            </label>

            <label className="text-xs sm:col-span-2">
              <span className="mb-1 block font-bold text-slate-600">تكلفة المعمل (اختياري)</span>
              <input
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="المبلغ المحتسب من المعمل"
                inputMode="decimal"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
              />
            </label>

            <label className="text-xs sm:col-span-2">
              <span className="mb-1 block font-bold text-slate-600">ملاحظات لفني المختبر</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="تعليمات إضافية للفني..."
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
              />
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowAdd(false)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-1.5 text-xs font-bold text-slate-600"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={busy || !labName.trim()}
              className="rounded-xl bg-brand-orange px-5 py-1.5 text-xs font-bold text-white disabled:opacity-40"
            >
              حفظ وإرسال للطلب
            </button>
          </div>
        </form>
      ) : null}

      {loading ? (
        <p role="status" className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-400">
          جارٍ التحميل…
        </p>
      ) : currentRead?.status === "error" ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700">
          <p role="alert">{currentRead.message}</p>
          <button type="button" onClick={() => void load()} disabled={busy || !hasContext}
            className="mt-2 rounded-lg border border-red-200 bg-white px-3 py-1.5 font-bold disabled:opacity-40">
            إعادة تحميل طلبات المعمل
          </button>
        </div>
      ) : orders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center">
          <p className="text-sm font-bold text-slate-600">لا توجد طلبات معمل مسجلة لهذا المريض</p>
          <p className="mt-1 text-xs text-slate-400">
            يمكنك إرسال طلب تركيبات أو تقويم بنقرة زر ومتابعة مواعيد استلامها
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {orders.map((order) => {
            const statusConf = STATUS_MAP[order.status] ?? STATUS_MAP.sent;
            return (
              <div
                key={order.id}
                className="rounded-2xl border border-slate-200 bg-white p-4 transition-all hover:border-slate-300"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-extrabold text-navy-900">{order.workType}</span>
                      <span className={`rounded-lg border px-2 py-0.5 text-[11px] font-bold ${statusConf.bg} ${statusConf.text}`}>
                        {statusConf.label}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      المختبر: <span className="font-bold text-navy-800">{order.labName}</span>
                      {order.details ? ` · التفاصيل: ${order.details}` : ""}
                    </p>

                    {/* عرض شارات الأسنان والأدوار */}
                    {order.toothNumbers && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        {Object.entries(parseLabTeeth(order.toothNumbers)).map(([codeStr, role]) => {
                          const code = Number(codeStr);
                          const meta = LAB_TOOTH_ROLE_META[role];
                          return (
                            <span
                              key={code}
                              className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-bold border ${
                                meta ? meta.badgeClass : "bg-slate-100 text-slate-700 border-slate-200"
                              }`}
                            >
                              <span>{meta?.icon || "🦷"}</span>
                              <span className="font-mono font-black">{code}</span>
                              <span className="text-[8px] font-normal">({meta?.shortLabel || role})</span>
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="text-left text-xs">
                    <p className="font-bold text-slate-700">
                      التسليم: {friendlyDate(order.dueDate)}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      أُرسل: {friendlyDate(order.sentDate)}
                    </p>
                  </div>
                </div>

                {order.note ? (
                  <p className="mt-2 rounded-xl bg-slate-50 p-2 text-xs text-slate-600">
                    💬 {order.note}
                  </p>
                ) : null}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5 text-xs">
                  <div>
                    {order.baseAmountMinor ? (
                      <span className="text-[11px] font-bold text-slate-500">
                        التكلفة: {formatMoney(order.baseAmountMinor, base)}
                      </span>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setPrescriptionOrder(order)}
                      className="rounded-lg border border-navy-200 bg-navy-50/80 px-2.5 py-1 text-xs font-bold text-navy-900 hover:bg-navy-100"
                      title="عرض وطباعة الاستمارة السريرية"
                    >
                      📋 استمارة المختبر
                    </button>

                    {order.status === "sent" || order.status === "in_progress" ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void updateStatus(order.id, "received")}
                          disabled={busy}
                          className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-bold text-white transition-opacity hover:opacity-90"
                        >
                          ✓ استلام من المختبر
                        </button>
                        {admin ? (
                          <button
                            type="button"
                            onClick={() => void cancelSubmission(order)}
                            disabled={busy}
                            className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-bold text-red-700 transition-colors hover:bg-red-100 disabled:opacity-40"
                            title="إلغاء الإرسالية — للمدير وحده؛ الالتزام غير المسدَّد يُمحى"
                          >
                            ✕ إلغاء الإرسالية
                          </button>
                        ) : null}
                      </>
                    ) : null}

                    {order.status === "received" ? (
                      <>
                        <button
                          type="button"
                          onClick={() => setDeliveryAppointmentOrder(order)}
                          disabled={busy}
                          className="rounded-lg border border-blue-300 bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-800 hover:bg-blue-100 flex items-center gap-1 shadow-2xs"
                          title="حجز موعد تسليم وتركيب للعمل في جدول المواعيد"
                        >
                          <span>📅</span>
                          <span>حجز موعد تسليم</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => void updateStatus(order.id, "delivered")}
                          disabled={busy}
                          className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-bold text-white transition-opacity hover:opacity-90"
                        >
                          ✓ تسليم وتركيب للمريض
                        </button>
                      </>
                    ) : null}

                    <a
                      href={`/lab`}
                      className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-navy-800 hover:bg-slate-50"
                    >
                      عرض في سجل المعامل
                    </a>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* نافذة استمارة طلب المعمل */}
      {prescriptionOrder && (
        <LabPrescriptionModal
          order={prescriptionOrder}
          clinicName={clinicName}
          clinicPhone={clinicPhone}
          onClose={() => setPrescriptionOrder(null)}
        />
      )}

      {/* نافذة تذكير وحجز موعد تسليم وتركيب */}
      {deliveryAppointmentOrder && (
        <LabDeliveryAppointmentModal
          order={deliveryAppointmentOrder}
          clinicName={clinicName}
          clinicPhone={clinicPhone}
          isOpen={true}
          onClose={() => setDeliveryAppointmentOrder(null)}
          onAppointmentBooked={() => {
            void load();
          }}
        />
      )}
    </div>
  );
}
