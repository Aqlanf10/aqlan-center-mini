"use client";

import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { useEffect, useState } from "react";
import { formatMoney, type Currency } from "@/lib/money";
import { friendlyDate } from "@/lib/reminders";
import {
  type LabOrder,
  LAB_TOOTH_ROLE_META,
  parseLabTeeth,
  WORK_TYPES,
} from "@/lib/lab";
import { LabDentalChart } from "./LabDentalChart";
import { LabPrescriptionModal } from "./LabPrescriptionModal";
import { LabDeliveryAppointmentModal } from "./LabDeliveryAppointmentModal";
import { useClinicName, useSetting } from "./SettingsProvider";
import { useSession } from "./SessionProvider";
import { isAdmin } from "@/lib/roles";
import { usePatientLabRead } from "./usePatientLabRead";
import type { PatientLabSnapshot } from "@/lib/patient-lab-read";

const STATUS_MAP: Record<string, { label: string; bg: string; text: string }> = {
  needed: { label: "لم يُرسل بعد — من إجراء الزيارة", bg: "bg-sky-50 border-sky-200", text: "text-sky-700" },
  sent: { label: "قيد العمل بالمختبر", bg: "bg-amber-50 border-amber-200", text: "text-amber-700" },
  in_progress: { label: "قيد التصنيع في المعمل", bg: "bg-violet-50 border-violet-200", text: "text-violet-700" },
  received: { label: "مستلم بالعيادة", bg: "bg-blue-50 border-blue-200", text: "text-blue-700" },
  delivered: { label: "تم التسليم للمريض", bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700" },
  remake: { label: "إعادة تصنيع", bg: "bg-red-50 border-red-200", text: "text-red-700" },
  cancelled: { label: "ملغى", bg: "bg-slate-50 border-slate-200", text: "text-slate-500" },
};

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

  const authorityKey = session ? JSON.stringify([session.username, session.role, session.permissions ?? null]) : null;
  const read = usePatientLabRead(patientId, authorityKey);
  const { owner, load, scope } = read;
  const orders = read.ready ? read.data!.orders : [];
  const labs = read.ready ? read.data!.labs : [];
  const [draftScope, setDraftScope] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [busyOwner, setBusyOwner] = useState<typeof owner | null>(null);
  const busy = busyOwner === owner;
  const [actionError, setActionError] = useState<{ owner: typeof owner; message: string } | null>(null);
  const error = actionError?.owner === owner ? actionError.message : null;
  const setError = (message: string | null) => setActionError(message ? { owner, message } : null);
  const beginAction = () => {
    if (!read.canAct() || owner.writing) return false;
    owner.writing = true;
    setBusyOwner(owner);
    setError(null);
    return true;
  };
  const finishAction = () => {
    owner.writing = false;
    if (read.isCurrent()) setBusyOwner(null);
  };

  // حقول الإضافة
  const [labName, setLabName] = useState("");
  const [workType, setWorkType] = useState(WORK_TYPES[0]);
  const [customWork, setCustomWork] = useState("");
  const [toothNumbers, setToothNumbers] = useState("");
  const [shade, setShade] = useState("");
  const [priority, setPriority] = useState<"normal" | "urgent" | "rush">("normal");
  const [details, setDetails] = useState("");
  const [showChart, setShowChart] = useState(false);
  const [sentDate, setSentDate] = useState(() => clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));
  const [dueDate, setDueDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 5);
    return d.toISOString().slice(0, 10);
  });
  const [cost, setCost] = useState("");
  const [note, setNote] = useState("");
  /* المختبرات المسجّلة (جهات المختبر): التكلفة لا تُسجّل إلا على جهة، وإلا رفضها
     الخادم — فكان حقل التكلفة هنا يفشل دائمًا بلا جهة. */
  const [labCatalog, setLabCatalog] = useState<{ owner: typeof owner; labs: { id: number; name: string }[] } | null>(null);
  const registeredLabs = read.ready && labCatalog?.owner === owner ? labCatalog.labs : [];
  type Selection = { snapshot: PatientLabSnapshot; order: LabOrder };
  const [prescriptionOrder, setPrescriptionOrder] = useState<Selection | null>(null);
  const [deliveryAppointmentOrder, setDeliveryAppointmentOrder] = useState<Selection | null>(null);

  // Optional cost-party catalogue is also owned by this patient/session lifetime.
  // Failure must not keep another authority's party IDs available for submission.
  useEffect(() => {
    if (!authorityKey) return;
    const controller = new AbortController();
    let current = true;
    void (async () => {
      try {
        const res = await fetch("/api/laboratories", { cache: "no-store", signal: controller.signal });
        if (!res.ok) return;
        const data = await res.json();
        if (!current || !owner.active || !Array.isArray(data?.laboratories)) return;
        const list = data.laboratories as { id: number; name: string; isActive?: boolean }[];
        if (!list.every((lab) => lab && Number.isSafeInteger(lab.id) && lab.id > 0 && typeof lab.name === "string")) return;
        setLabCatalog({ owner, labs: list.filter((lab) => lab.isActive !== false).map(({ id, name }) => ({ id, name })) });
      } catch {
        // No verified catalogue means no cost-party submission; the draft remains.
      }
    })();
    return () => { current = false; controller.abort(); };
  }, [owner, authorityKey]);

  const openOrder = (order: LabOrder, kind: "prescription" | "appointment") => {
    if (!read.canAct() || owner.writing || !read.data?.orders.includes(order)) return;
    const selection = { snapshot: read.data, order };
    if (kind === "prescription") setPrescriptionOrder(selection);
    else setDeliveryAppointmentOrder(selection);
  };

  const toggleDraft = () => {
    if (!read.canAct() || owner.writing || (draftScope !== null && draftScope !== scope)) return;
    setDraftScope(scope);
    setShowAdd(!showAdd);
  };

  const submitOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!read.canAct() || draftScope !== scope || !labName.trim() || owner.writing) return;

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

    if (!beginAction()) return;

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
      const data = await res.json().catch(() => null);
      if (!read.canAct()) return;
      if (!res.ok) {
        setError(data?.message ?? "تعذّر حفظ طلب المعمل.");
        return;
      }
      setShowAdd(false);
      setDraftScope(null);
      setToothNumbers("");
      setShade("");
      setDetails("");
      setCost("");
      setNote("");
      await load();
    } catch {
      if (read.canAct()) setError("تعذّر الاتصال بالخادم.");
    } finally {
      finishAction();
    }
  };

  const updateStatus = async (orderId: number, nextStatus: "received" | "delivered") => {
    if (!orders.some((order) => order.id === orderId) || !beginAction()) return;
    try {
      const res = await fetch(`/api/lab/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = await res.json().catch(() => null);
      if (!read.canAct()) return;
      if (!res.ok) {
        setError(data?.message ?? "تعذّر تحديث طلب المعمل.");
        // A rejected status change leaves its prior status unverified too.
        await load();
        return;
      }
      const refreshed = await load();
      const target = refreshed?.orders.find((order) => order.id === orderId && order.status === "received");
      if (nextStatus === "received" && target && refreshed && read.isSnapshot(refreshed)) {
        setDeliveryAppointmentOrder({ snapshot: refreshed, order: target });
      }
    } catch {
      if (read.canAct()) {
        setError("تعذّر الاتصال بالخادم. راجع حالة الطلب قبل إعادة الإجراء.");
        await load();
      }
    } finally {
      finishAction();
    }
  };

  /* إلغاء إرسالية قائمة عند المختبر — من ملف المريض، والمدير وحده: الخادم يحرس
   * البوابة نفسها (رسالة واضحة لغيره)، والزر لا يظهر له أصلًا. */
  const cancelSubmission = async (order: LabOrder) => {
    if (!read.canAct() || owner.writing || !admin || !orders.includes(order)) return;
    const hasCost = Number(order.costMinor) > 0;
    const message = hasCost
      ? `إلغاء إرسالية «${order.workType}» إلى «${order.labName}»؟\nالتزامها غير المسدَّد يُمحى معها. إن كان مسدَّدًا بسند صرف يبقى أثره المالي للتدقيق.`
      : `إلغاء إرسالية «${order.workType}» إلى «${order.labName}»؟`;
    if (!window.confirm(message) || !beginAction()) return;
    try {
      const res = await fetch(`/api/lab/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled", note: "إلغاء من ملف المريض" }),
      });
      const data = await res.json().catch(() => null);
      if (!read.canAct()) return;
      if (!res.ok) {
        setError(data?.message ?? "تعذّر إلغاء الإرسالية.");
        return;
      }
      await load();
    } catch {
      if (read.canAct()) setError("تعذّر الاتصال بالخادم.");
    } finally {
      finishAction();
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-navy-900">أعمال وتركيبات المعمل{read.ready ? ` (${orders.length} ضمن القائمة المتاحة)` : ""}</h3>
          <p className="text-xs text-slate-500">متابعة التركيبات والتيجان والأطقم للمريض وتاريخ استلامها</p>
        </div>
        <button
          type="button"
          onClick={toggleDraft}
          disabled={!read.ready || busy || (draftScope !== null && draftScope !== scope)}
          className="rounded-xl bg-navy-800 px-3.5 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90"
        >
          {showAdd ? "إلغاء" : "+ طلب معمل جديد"}
        </button>
      </div>

      <button type="button" onClick={() => { if (read.isCurrent() && !owner.writing) void load(); }} disabled={busy || !authorityKey}
        className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-navy-800 disabled:opacity-40">
        {(read.phase === "error" || read.phase === "denied") ? "إعادة محاولة تحميل طلبات المعمل" : "تحديث طلبات المعمل"}
      </button>
      {read.error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">{read.error}</div> : null}
      {draftScope !== null && draftScope !== scope ? (
        <p role="status" className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800">المسودة المحلية تخص مريضًا أو جلسة أخرى؛ ارجع إلى سياقها لمراجعتها. لم تُرسل ولم تُنقل إلى هذا المريض.</p>
      ) : null}
      {showAdd && draftScope === scope && !read.showDraft ? (
        <p role="status" className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800">المسودة المحلية محفوظة ومخفية حتى تنجح إعادة التحقق من المريض والجلسة.</p>
      ) : null}
      {showAdd && draftScope === scope && read.showDraft && !read.ready ? (
        <p role="status" className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800">المسودة محفوظة في هذه الشاشة. إرسالها متوقف حتى تنجح إعادة تحميل طلبات المعمل.</p>
      ) : null}

      {error && read.showDraft ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div>
      ) : null}

      {showAdd && draftScope === scope && read.showDraft ? (
        <form onSubmit={submitOrder} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-3">
          <fieldset disabled={!read.ready || busy} className="space-y-3">
          <legend className="text-xs font-bold text-navy-900">إرسال عمل جديد إلى المختبر</legend>
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
                {[...new Set([...registeredLabs.map((l) => l.name), ...labs.map((l) => l.labName)])].map((name) => (
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
              onClick={() => { if (read.isCurrent() && !owner.writing) setShowAdd(false); }}
              className="rounded-xl border border-slate-200 bg-white px-4 py-1.5 text-xs font-bold text-slate-600"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={!read.ready || busy || !labName.trim()}
              className="rounded-xl bg-brand-orange px-5 py-1.5 text-xs font-bold text-white disabled:opacity-40"
            >
              حفظ وإرسال للطلب
            </button>
          </div>
          </fieldset>
        </form>
      ) : null}

      {read.phase === "loading" ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-400">
          جارٍ التحميل…
        </p>
      ) : !read.ready ? null : orders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center">
          <p className="text-sm font-bold text-slate-600">لا توجد طلبات لهذا المريض ضمن قائمة المعمل المتاحة</p>
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
                      onClick={() => openOrder(order, "prescription")}
                      disabled={busy}
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
                          onClick={() => openOrder(order, "appointment")}
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
      {prescriptionOrder && read.isSnapshot(prescriptionOrder.snapshot) && (
        <LabPrescriptionModal
          order={prescriptionOrder.order}
          clinicName={clinicName}
          clinicPhone={clinicPhone}
          onClose={() => { if (read.isSnapshot(prescriptionOrder.snapshot)) setPrescriptionOrder(null); }}
        />
      )}

      {/* نافذة تذكير وحجز موعد تسليم وتركيب */}
      {deliveryAppointmentOrder && read.isSnapshot(deliveryAppointmentOrder.snapshot) && (
        <LabDeliveryAppointmentModal
          order={deliveryAppointmentOrder.order}
          clinicName={clinicName}
          clinicPhone={clinicPhone}
          isOpen={true}
          onClose={() => { if (read.isSnapshot(deliveryAppointmentOrder.snapshot)) setDeliveryAppointmentOrder(null); }}
          onAppointmentBooked={() => {
            if (read.isSnapshot(deliveryAppointmentOrder.snapshot)) void load();
          }}
        />
      )}
    </div>
  );
}
