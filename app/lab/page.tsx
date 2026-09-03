"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClinicName, useSetting } from "@/components/SettingsProvider";
import { CURRENCIES, CURRENCY_LABEL, CURRENCY_SHORT, formatAmount, isCurrency, toInputAmount, type Currency } from "@/lib/money";
import { friendlyDateLong, toWhatsAppNumber } from "@/lib/reminders";
import { addDays, clinicDateString } from "@/lib/schedule";
import {
  LAB_FILTER_LABEL,
  LAB_STATUS_LABEL,
  WORK_TYPES,
  daysLate,
  filterOrders,
  labFollowUpText,
  labSummary,
  patientReadyText,
  sortByUrgency,
  type LabFilter,
  type LabOrder,
  type LabOrderStatus,
  type LabService,
  LAB_SERVICE_CATEGORY_META,
  LAB_TOOTH_SCOPE_META,
  LAB_TOOTH_ROLE_META,
  parseLabTeeth,
  summarizeLabTeeth,
} from "@/lib/lab";
import { PageHeader, StatCard as Stat } from "@/components/PageHeader";
import { LabDentalChart } from "@/components/LabDentalChart";
import { LabPrescriptionModal } from "@/components/LabPrescriptionModal";
import { LabDeliveryAppointmentModal } from "@/components/LabDeliveryAppointmentModal";
import { LabOrderAccountingModal, type ExpenseCategoryOption } from "@/components/LabOrderAccountingModal";

/**
 * أعمال المختبر ومعامل الأسنان — تتبع التراكيب، تسليم الأجهزة، والتواصل المباشر مع المعامل والمرضى.
 */

interface Patient {
  id: number;
  patientNumber: string;
  fullName: string;
  phone: string | null;
}

interface LaboratoryItem {
  id: number;
  name: string;
  phone: string | null;
  whatsapp: string | null;
  currency: Currency;
  deliveryDays: number;
  isActive: boolean;
}

interface LabFeed {
  orders: LabOrder[];
  labs: { labName: string; labPhone: string | null }[];
}

const FILTERS: LabFilter[] = ["pending", "late", "outstanding", "unposted", "received", "all"];

export default function LabPage() {
  const clinicName = useClinicName();
  const baseSettingValue = useSetting("finance.base_currency");
  const clinicPhone = useSetting("clinic.phone");
  const labDays = Number(useSetting("lab.default_days")) || 7;
  const [feed, setFeed] = useState<LabFeed>({ orders: [], labs: [] });
  const [filter, setFilter] = useState<LabFilter>("late");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const inFlight = useRef(false);

  // External Catalogs
  const [services, setServices] = useState<LabService[]>([]);
  const [laboratories, setLaboratories] = useState<LaboratoryItem[]>([]);

  // Search & Filter
  const [search, setSearch] = useState("");

  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);

  // Form State
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Patient[]>([]);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [partyId, setPartyId] = useState("");
  const [labName, setLabName] = useState("");
  const [labPhone, setLabPhone] = useState("");
  const [labServiceId, setLabServiceId] = useState("");
  const [workType, setWorkType] = useState(WORK_TYPES[0]);
  const [details, setDetails] = useState("");
  const [toothNumbers, setToothNumbers] = useState("");
  const [shade, setShade] = useState("");
  const [priority, setPriority] = useState<"normal" | "urgent" | "rush">("normal");
  const [impressionType, setImpressionType] = useState<"physical" | "digital_scan" | "other">("physical");
  const [sentDate, setSentDate] = useState(today);
  const [dueDate, setDueDate] = useState(() => addDays(today, labDays));
  const [cost, setCost] = useState("");
  const [costCurrency, setCostCurrency] = useState<Currency>(
    isCurrency(baseSettingValue) ? baseSettingValue : "YER",
  );
  const [resolvedPricingInfo, setResolvedPricingInfo] = useState<{
    costMinor: number;
    costCurrency: Currency;
    ruleId: number;
  } | null>(null);

  // Dental Chart & Prescription Sheet Modals
  const [showDentalChart, setShowDentalChart] = useState(true);
  const [prescriptionOrder, setPrescriptionOrder] = useState<LabOrder | null>(null);
  const [deliveryAppointmentOrder, setDeliveryAppointmentOrder] = useState<LabOrder | null>(null);
  /* الربط المحاسبي (بنود المصروفات): نافذة الترحيل، قائمة البنود، واختيار النموذج. */
  const [accountingOrder, setAccountingOrder] = useState<LabOrder | null>(null);
  const [expenseCategories, setExpenseCategories] = useState<ExpenseCategoryOption[]>([]);
  const [formExpenseCategoryId, setFormExpenseCategoryId] = useState<string>("");
  const [autoPostExpense, setAutoPostExpense] = useState<boolean>(true);

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const response = await fetch("/api/lab", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setFeed(payload as LabFeed);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  // Load registered labs, services catalog & expense categories
  useEffect(() => {
    void (async () => {
      try {
        const [labsRes, svcsRes, expRes] = await Promise.all([
          fetch("/api/laboratories", { cache: "no-store" }),
          fetch("/api/lab/services", { cache: "no-store" }),
          fetch("/api/finance/expense-categories", { cache: "no-store" }),
        ]);
        if (labsRes.ok) {
          const labsData = await labsRes.json();
          setLaboratories((labsData.laboratories || []).filter((l: LaboratoryItem) => l.isActive));
        }
        if (svcsRes.ok) {
          const svcsData = await svcsRes.json();
          setServices((svcsData.services || []).filter((s: LabService) => s.isActive));
        }
        if (expRes.ok) {
          const expData = await expRes.json();
          setExpenseCategories(expData.categories || []);
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  // Auto-resolve pricing when lab, service, and sentDate are selected
  useEffect(() => {
    if (!partyId || !labServiceId) {
      setResolvedPricingInfo(null);
      return;
    }

    let active = true;
    void (async () => {
      try {
        const res = await fetch(
          `/api/lab/pricing?partyId=${partyId}&labServiceId=${labServiceId}&date=${sentDate}&resolve=1`,
          { cache: "no-store" },
        );
        if (res.ok && active) {
          const data = await res.json();
          if (data.resolved) {
            setResolvedPricingInfo(data.resolved);
            /* السعر الراجع من الخادم بالوحدات الصغرى (سنتات)؛ تُحوَّل إلى وحدات
               كبرى لملء الخانة — ملؤها بالقيمة الصغرى كان يجلب ٢٠٠٠ بدل ٢٠
               دولار ثم تُخزَّن ألفين عند الحفظ (مئة ضعف مرتين). */
            setCost(toInputAmount(Number(data.resolved.costMinor), data.resolved.costCurrency));
            setCostCurrency(data.resolved.costCurrency);
          } else {
            setResolvedPricingInfo(null);
          }
        }
      } catch {
        if (active) setResolvedPricingInfo(null);
      }
    })();

    return () => {
      active = false;
    };
  }, [partyId, labServiceId, sentDate]);

  useEffect(() => {
    if (patient || query.trim().length < 2) {
      setMatches([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/patients?q=${encodeURIComponent(query.trim())}`, {
          cache: "no-store",
        });
        if (response.ok) setMatches(await response.json());
      } catch {
        /* تجاهل */
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, patient]);

  const act = useCallback(
    async (run: () => Promise<Response>) => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setBusy(true);
      try {
        const response = await run();
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          setError(payload?.message ?? "تعذّر تنفيذ الإجراء.");
          await load(false);
          return false;
        }
        setError(null);
        await load(false);
        return true;
      } catch {
        setError("تعذّر الاتصال بالخادم.");
        return false;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [load],
  );

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!patient) {
        setError("اختر المريض من نتائج البحث.");
        return;
      }
      if (!labName.trim()) {
        setError("يرجى تحديد اسم المختبر.");
        return;
      }
      const ok = await act(() =>
        fetch("/api/lab", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            patientId: patient.id,
            labName,
            labPhone: labPhone || undefined,
            workType,
            details: details || undefined,
            toothNumbers: toothNumbers || undefined,
            shade: shade || undefined,
            priority,
            impressionType,
            sentDate,
            dueDate,
            partyId: partyId ? Number(partyId) : undefined,
            labServiceId: labServiceId ? Number(labServiceId) : undefined,
            cost: cost ? cost : undefined,
            costCurrency: cost ? costCurrency : undefined,
            /* الترحيل المحاسبي: بند المصروف وحالة الترحيل من النموذج. */
            expenseCategoryId: formExpenseCategoryId ? Number(formExpenseCategoryId) : undefined,
            isPosted: autoPostExpense,
          }),
        }),
      );
      if (ok) {
        setPatient(null);
        setQuery("");
        setDetails("");
        setToothNumbers("");
        setShade("");
        setCost("");
        setPartyId("");
        setLabServiceId("");
        setFormExpenseCategoryId("");
        setSentDate(today);
        setDueDate(addDays(today, labDays));
        setResolvedPricingInfo(null);
        setAdding(false);
        setFilter("outstanding");
      }
    },
    [
      act,
      patient,
      toothNumbers,
      shade,
      priority,
      impressionType,
      details,
      labName,
      labPhone,
      workType,
      sentDate,
      dueDate,
      partyId,
      labServiceId,
      cost,
      costCurrency,
      formExpenseCategoryId,
      autoPostExpense,
      today,
      labDays,
    ],
  );

  const updateOrderStatus = async (orderId: number, status: LabOrderStatus) => {
    const ok = await act(() =>
      fetch(`/api/lab/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }),
    );
    if (ok && status === "received") {
      const orderObj = feed.orders.find((o) => o.id === orderId);
      if (orderObj) {
        setDeliveryAppointmentOrder({ ...orderObj, status: "received" });
      }
    }
  };

  const summary = useMemo(() => labSummary(feed.orders, today), [feed.orders, today]);

  const visible = useMemo(() => {
    let list = filterOrders(feed.orders, filter, today);
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter(
        (o) =>
          o.patientName.toLowerCase().includes(q) ||
          o.labName.toLowerCase().includes(q) ||
          o.workType.toLowerCase().includes(q) ||
          (o.details ?? "").toLowerCase().includes(q),
      );
    }
    return sortByUrgency(list, today);
  }, [feed.orders, filter, today, search]);

  return (
    <main className="mx-auto max-w-4xl p-4 pb-24">
      <PageHeader
        title="أعمال المختبر ومعامل الأسنان"
        subtitle="متابعة تراكيب الزيركون، البورسلين، والأجهزة التقويمية ومواعيد الاستلام والتسليم والتسعير الفوري"
      >
        <div className="flex flex-wrap items-center gap-2">
          <a
            href="/settings/laboratories"
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-800 transition hover:bg-slate-50"
          >
            المختبرات ‹
          </a>
          <a
            href="/settings/lab-services"
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-purple-700 transition hover:bg-purple-50"
          >
            دليل الخدمات ‹
          </a>
          <a
            href="/settings/lab-pricing"
            className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800 transition hover:bg-emerald-100"
          >
            🏷️ جدول التسعير ‹
          </a>
          {!adding ? (
            <button
              onClick={() => setAdding(true)}
              className="rounded-xl bg-brand-orange px-4 py-2 text-xs font-extrabold text-white shadow-xs hover:opacity-90"
            >
              + إرسال عمل جديد للمختبر
            </button>
          ) : null}
        </div>
      </PageHeader>

      {/* ملخص إحصاءات أعمال المختبر */}
      <section className="mb-4 grid grid-cols-3 gap-2" aria-label="ملخص المختبر">
        <Stat label="متأخرة عن الموعد" value={summary.late} tone={summary.late > 0 ? "bad" : "calm"} />
        <Stat label="تستحق اليوم" value={summary.dueToday} tone={summary.dueToday > 0 ? "warn" : "calm"} />
        <Stat label="وصلت بالعيادة جاهزة للتركيب" value={summary.waitingFitting} tone={summary.waitingFitting > 0 ? "warn" : "calm"} />
      </section>

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-xs font-bold text-red-700">
          {error}
        </p>
      ) : null}

      {/* نموذج إضافة عمل مخبري جديد */}
      {adding && (
        <form onSubmit={submit} className="mb-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between border-b border-slate-100 pb-3">
            <h2 className="text-xs font-extrabold text-navy-900">+ تسجيل عمل مخبري جديد مع التسعير الآلي</h2>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="text-xs font-bold text-slate-500 hover:text-slate-700"
            >
              إلغاء ✕
            </button>
          </div>

          {/* اختيار المريض */}
          {patient ? (
            <div className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-navy-800 bg-navy-50/50 px-3.5 py-2.5">
              <div>
                <span className="text-xs font-extrabold text-navy-900">{patient.fullName}</span>
                <span className="mr-2 text-[11px] text-slate-500">{patient.patientNumber}</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setPatient(null);
                  setQuery("");
                }}
                className="text-xs font-bold text-navy-800 hover:underline"
              >
                تغيير المريض
              </button>
            </div>
          ) : (
            <div className="relative mb-3">
              <label className="block text-[11px] font-bold text-slate-600 mb-1">المريض *</label>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="ابحث عن المريض بالاسم أو رقم الملف…"
                aria-label="بحث عن المريض"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
              {matches.length > 0 ? (
                <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl">
                  {matches.map((match) => (
                    <li key={match.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setPatient(match);
                          setMatches([]);
                        }}
                        className="w-full px-3 py-2 text-right text-xs hover:bg-slate-50"
                      >
                        <span className="font-bold text-navy-900">{match.fullName}</span>
                        <span className="mr-2 text-slate-400">{match.patientNumber}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}

          {/* اختيار المختبر والخدمة */}
          <div className="grid gap-3 sm:grid-cols-2">
            {/* المختبر */}
            <div>
              <label className="mb-1 block text-[11px] font-bold text-slate-600">المختبر / المعمل *</label>
              {laboratories.length > 0 ? (
                <select
                  value={partyId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setPartyId(id);
                    const selectedLab = laboratories.find((l) => String(l.id) === id);
                    if (selectedLab) {
                      setLabName(selectedLab.name);
                      setLabPhone(selectedLab.whatsapp || selectedLab.phone || "");
                      setCostCurrency(selectedLab.currency);
                      if (selectedLab.deliveryDays) {
                        setDueDate(addDays(sentDate, selectedLab.deliveryDays));
                      }
                    }
                  }}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
                >
                  <option value="">-- اختر المختبر المعتمد --</option>
                  {laboratories.map((lab) => (
                    <option key={lab.id} value={lab.id}>
                      {lab.name} ({lab.currency})
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={labName}
                  onChange={(event) => setLabName(event.target.value)}
                  placeholder="اسم المختبر"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
                />
              )}
            </div>

            {/* الخدمة من الكتالوج أو نوع العمل */}
            <div>
              <label className="mb-1 block text-[11px] font-bold text-slate-600">
                خدمة المختبر (دليل الخدمات)
              </label>
              {services.length > 0 ? (
                <select
                  value={labServiceId}
                  onChange={(e) => {
                    const sId = e.target.value;
                    setLabServiceId(sId);
                    const selectedSvc = services.find((s) => String(s.id) === sId);
                    if (selectedSvc) {
                      setWorkType(selectedSvc.name);
                      if (selectedSvc.defaultDays && !partyId) {
                        setDueDate(addDays(sentDate, selectedSvc.defaultDays));
                      }
                    }
                  }}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
                >
                  <option value="">-- اختر من دليل خدمات المختبر --</option>
                  {services.map((svc) => (
                    <option key={svc.id} value={svc.id}>
                      {svc.name} {svc.code ? `[#${svc.code}]` : ""} ({LAB_SERVICE_CATEGORY_META[svc.category]?.shortLabel})
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  value={workType}
                  onChange={(event) => setWorkType(event.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
                >
                  {WORK_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* مخطط الأسنان FDI التفاعلي لطلبات المختبر */}
          <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-3 shadow-2xs">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-base">🦷</span>
                <div>
                  <h4 className="text-xs font-black text-navy-950">
                    مخطط الأسنان FDI التفاعلي (11-48, 51-85)
                  </h4>
                  <p className="text-[10px] text-slate-500">
                    حدد الأسنان والأدوار التعويضية (تاج / دعامة جسر / دمية جسر / فينير)
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowDentalChart((prev) => !prev)}
                className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-bold text-navy-900 hover:bg-slate-100"
              >
                {showDentalChart ? "إخفاء المخطط ▲" : "عرض المخطط التفاعلي ▼"}
              </button>
            </div>

            {showDentalChart && (
              <div className="mt-2">
                <LabDentalChart
                  value={toothNumbers}
                  onChange={(serialized) => setToothNumbers(serialized)}
                  showSummary={true}
                />
              </div>
            )}
          </div>

          {/* تفاصيل الأسنان واللون والأولوية */}
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-[11px] font-bold text-slate-500">
                الأسنان المحددة (نص التقرير)
              </label>
              <input
                value={toothNumbers}
                onChange={(e) => setToothNumbers(e.target.value)}
                placeholder="مثال: 14(Abutment), 15(Pontic), 16(Abutment)"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-mono outline-none focus:border-navy-800"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-bold text-slate-500">اللون وتدرج الظل</label>
              <input
                value={shade}
                onChange={(e) => setShade(e.target.value)}
                placeholder="مثال: A2 أو A3.5 أو BL2"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-bold text-slate-500">الأولوية</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as any)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
              >
                <option value="normal">عادي</option>
                <option value="urgent">مستعجل</option>
                <option value="rush">طارئ فوري</option>
              </select>
            </div>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-bold text-slate-500">المواصفات والتعليمات الفنية</label>
              <input
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                placeholder="مثال: تشريح عالي، مع دعامة مخصصة، إطباق خفيف..."
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-bold text-slate-500">نوع الطبعة / الإرسال</label>
              <select
                value={impressionType}
                onChange={(e) => setImpressionType(e.target.value as any)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
              >
                <option value="physical">طبعة تقليدية</option>
                <option value="digital_scan">مسح رقمي ثلاثي الأبعاد</option>
                <option value="other">أخرى / قالب جاهز</option>
              </select>
            </div>
          </div>

          {/* التواريخ */}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-bold text-slate-500">تاريخ الإرسال</label>
              <input
                type="date"
                value={sentDate}
                onChange={(e) => setSentDate(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-bold text-slate-500">تاريخ الاستحقاق المتوقع</label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
            </div>
          </div>

          {/* التسعير والتكلفة مع إشعار السعر التلقائي */}
          <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/70 p-3">
            {resolvedPricingInfo ? (
              <div className="mb-2 flex items-center gap-1.5 rounded-lg bg-emerald-50 border border-emerald-200 p-2 text-xs font-bold text-emerald-800">
                <span>✨</span>
                <span>
                  تم جلب السعر تلقائياً من جدول تسعير المختبر الساري ({formatAmount(resolvedPricingInfo.costMinor, resolvedPricingInfo.costCurrency)} {CURRENCY_LABEL[resolvedPricingInfo.costCurrency]})
                </span>
              </div>
            ) : partyId && labServiceId ? (
              <div className="mb-2 flex items-center gap-1.5 rounded-lg bg-amber-50 border border-amber-200 p-2 text-[11px] text-amber-800 font-medium">
                <span>ℹ️</span>
                <span>لا توجد قاعدة تسعير سارية لهذا المعمل والخدمة بتاريخ {sentDate}. يمكنك إدخال السعر يدوياً أو إضافته في جدول التسعير.</span>
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] font-bold text-slate-600">التكلفة المالية (اختياري)</label>
                <input
                  type="number"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                  placeholder="تكلفة المختبر"
                  min="0"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800 font-mono"
                />
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-bold text-slate-600">العملة</label>
                <select
                  value={costCurrency}
                  onChange={(e) => setCostCurrency(e.target.value as Currency)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {CURRENCY_LABEL[c]} ({c})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* ربط بند المصروفات المحاسبي */}
            <div className="mt-3">
              <label className="mb-1 block text-[11px] font-bold text-slate-600">
                بند المصروفات المرتبط (دليل الحسابات المالي)
              </label>
              <select
                value={formExpenseCategoryId}
                onChange={(e) => setFormExpenseCategoryId(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
              >
                <option value="">-- ربط تلقائي ببند مصاريف المعامل (حـ/ 5101) --</option>
                {expenseCategories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name} ({cat.categoryGroup}) — حـ/ {cat.accountCode || "5101"}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-3 flex items-center justify-between rounded-lg bg-white p-2.5 border border-slate-200">
              <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-slate-700">
                <input
                  type="checkbox"
                  checked={autoPostExpense}
                  onChange={(e) => setAutoPostExpense(e.target.checked)}
                  className="w-4 h-4 rounded text-navy-800 focus:ring-navy-700"
                />
                <span>ترحيل القيد المحاسبي فورياً وإثبات الالتزام المالي للمعمل</span>
              </label>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${
                autoPostExpense ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
              }`}>
                {autoPostExpense ? "مُرحّل نهائياً" : "مسوّدة (غير مُرحّل)"}
              </span>
            </div>

            {(cost || resolvedPricingInfo) && (
              <div className="mt-2.5 flex items-center gap-1.5 rounded-lg bg-navy-50/80 border border-navy-100 p-2 text-[11px] text-navy-800 font-medium">
                <span>⚡</span>
                <span>
                  <strong>الربط المحاسبي:</strong> سيتم توجيه قيد اليومية (من حـ/ مصاريف المعامل إلى حـ/ أمانات ومستحقات المعامل) مع فحص الدقة قبل الترحيل النهائي.
                </span>
              </div>
            )}
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={busy || !patient}
              className="rounded-xl bg-navy-800 px-5 py-2 text-xs font-bold text-white shadow-xs hover:opacity-90 disabled:opacity-40"
            >
              {busy ? "جارٍ الحفظ..." : "حفظ وإرسال الطلب"}
            </button>
          </div>
        </form>
      )}

      {/* شريط الفلترة والبحث */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-xs">
        <div className="flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
                filter === f
                  ? "bg-navy-800 text-white shadow-xs"
                  : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
              }`}
            >
              {LAB_FILTER_LABEL[f]}
            </button>
          ))}
        </div>

        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 بحث بالمريض أو المختبر…"
          className="w-full sm:w-56 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs outline-none focus:border-navy-800"
        />
      </div>

      {/* قائمة أعمال المختبر */}
      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-400">
          جارٍ تحميل أعمال المختبر…
        </p>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-xs text-slate-400">
          لا توجد أعمال تطابق الفلتر المحدد.
        </div>
      ) : (
        <ul className="space-y-3">
          {visible.map((order) => {
            const lateDays = daysLate(order, today);
            const isLate = lateDays > 0;
            const patientWa = toWhatsAppNumber(order.patientPhone);
            const labWa = toWhatsAppNumber(order.labPhone);

            // نصوص رسائل واتساب
            const patientMsg = patientReadyText(order, clinicName, clinicPhone);
            const labMsg = labFollowUpText(order, today, clinicName);

            return (
              <li
                key={order.id}
                className={`rounded-2xl border p-4 shadow-2xs transition-all ${
                  order.status === "delivered"
                    ? "border-slate-200 bg-slate-50/60 opacity-75"
                    : order.status === "received"
                    ? "border-emerald-200 bg-emerald-50/30"
                    : isLate
                    ? "border-red-300 bg-red-50/40"
                    : "border-slate-200 bg-white"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={`/patients/${order.patientId}`}
                        className="text-sm font-black text-navy-900 hover:underline underline-offset-4"
                      >
                        {order.patientName}
                      </a>
                      <span className="rounded-lg bg-navy-100 px-2 py-0.5 text-[11px] font-bold text-navy-900">
                        {order.workType}
                      </span>
                      {/* رحلة المريض V2 (§١٩): طلبٌ من إجراء الزيارة — سنّه ومصدره على البطاقة. */}
                      {order.toothCode ? (
                        <span className="rounded-lg bg-navy-50 px-2 py-0.5 text-[10px] font-bold text-navy-800">
                          سن {order.toothCode}
                        </span>
                      ) : null}
                      {order.source === "auto" ? (
                        <span className="rounded-lg bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-800">
                          من الزيارة
                        </span>
                      ) : null}
                      {order.shade ? (
                        <span className="rounded-lg bg-violet-100 px-2 py-0.5 text-[10px] font-bold text-violet-800">
                          لون: {order.shade}
                        </span>
                      ) : null}
                      {order.priority === "urgent" || order.priority === "rush" ? (
                        <span className={`rounded-lg px-2 py-0.5 text-[10px] font-bold ${
                          order.priority === "rush" ? "bg-red-200 text-red-800" : "bg-amber-200 text-amber-900"
                        }`}>
                          {order.priority === "rush" ? "طارئ جدًا" : "عاجل"}
                        </span>
                      ) : null}
                      {order.doctorName ? (
                        <span className="rounded-lg bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                          {order.doctorName}
                        </span>
                      ) : null}
                      <span
                        className={`rounded-lg px-2 py-0.5 text-[10px] font-bold ${
                          order.status === "needed"
                            ? "bg-sky-100 text-sky-800"
                            : order.status === "in_progress"
                            ? "bg-violet-100 text-violet-800"
                            : order.status === "remake"
                            ? "bg-red-100 text-red-700"
                            : order.status === "delivered"
                            ? "bg-slate-200 text-slate-700"
                            : order.status === "received"
                            ? "bg-emerald-200 text-emerald-800"
                            : isLate
                            ? "bg-red-200 text-red-800"
                            : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        {order.status === "needed"
                          ? "لم يُرسل بعد — من إجراء الزيارة"
                          : order.status === "in_progress"
                          ? "قيد التصنيع في المعمل"
                          : order.status === "remake"
                          ? "إعادة تصنيع"
                          : order.status === "delivered"
                          ? "تم التركيب للمريض ✓"
                          : order.status === "received"
                          ? "وصل للعيادة (بانتظار التركيب)"
                          : isLate
                          ? `متأخر ${lateDays} يوم`
                          : "عند المختبر"}
                      </span>
                    </div>

                    <p className="mt-1 text-xs text-slate-600">
                      معمل: <span className="font-bold text-navy-800">{order.labName}</span>
                      {order.details ? ` · ${order.details}` : ""}
                    </p>

                    {/* عرض تفاصيل الأسنان والأدوار التعويضية إن وجدت */}
                    {order.toothNumbers && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] font-bold text-slate-400">الأسنان والأدوار:</span>
                        {Object.entries(parseLabTeeth(order.toothNumbers)).map(([codeStr, role]) => {
                          const code = Number(codeStr);
                          const meta = LAB_TOOTH_ROLE_META[role];
                          return (
                            <span
                              key={code}
                              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold border ${
                                meta ? meta.badgeClass : "bg-slate-100 text-slate-700 border-slate-200"
                              }`}
                            >
                              <span>{meta?.icon || "🦷"}</span>
                              <span className="font-mono font-black">{code}</span>
                              <span className="font-normal text-[9px]">({meta?.shortLabel || role})</span>
                            </span>
                          );
                        })}
                      </div>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                      {order.status === "needed" ? (
                        <span>أُنشئ من توقيع الزيارة — أكمل بيانات المختبر ثم أرسله</span>
                      ) : (
                        <span>تاريخ الإرسال: {order.sentDate}</span>
                      )}
                      <span>موعد الاستحقاق: {friendlyDateLong(order.dueDate)}</span>
                      {order.receivedAt ? <span>استُلم بتاريخ: {order.receivedAt}</span> : null}

                      {/* شارة الربط المحاسبي والتكلفة */}
                      {Number(order.costMinor) > 0 ? (
                        <span className="font-mono font-bold text-slate-700">
                          التكلفة: {formatAmount(Number(order.costMinor), order.costCurrency || "YER")} {order.costCurrency || "YER"}
                        </span>
                      ) : null}

                      {order.isPosted ? (
                        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 text-emerald-800 border border-emerald-300 px-2 py-0.5 text-[10px] font-bold">
                          <span>✓</span>
                          <span>مُرحّل محاسبياً (حـ/ {order.expenseAccountCode || "5101"})</span>
                        </span>
                      ) : order.expenseCategoryId ? (
                        <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 text-amber-800 border border-amber-300 px-2 py-0.5 text-[10px] font-bold">
                          <span>⏳</span>
                          <span>مربوط بالمصروفات (بانتظار الترحيل النهائي)</span>
                        </span>
                      ) : Number(order.costMinor) > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 text-slate-600 border border-slate-200 px-2 py-0.5 text-[10px] font-bold">
                          <span>⚠️</span>
                          <span>غير مربوط بالمصروفات</span>
                        </span>
                      ) : null}
                    </div>
                  </div>

                  {/* الإجراءات وتحديث الحالة وتنبيهات واتساب واستمارة المختبر */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {/* زر الربط المحاسبي ببنود المصروفات والترحيل المالي */}
                    <button
                      type="button"
                      id={`lab-accounting-btn-${order.id}`}
                      onClick={() => setAccountingOrder(order)}
                      className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-bold shadow-2xs transition-colors ${
                        order.isPosted
                          ? "border-emerald-300 bg-emerald-50/90 text-emerald-800 hover:bg-emerald-100"
                          : order.expenseCategoryId
                          ? "border-amber-300 bg-amber-50/90 text-amber-900 hover:bg-amber-100"
                          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                      title="الربط المحاسبي لتكلفة أمر المعمل ببنود المصروفات والترحيل النهائي"
                    >
                      <span>⚖️</span>
                      <span>
                        {order.isPosted
                          ? "الربط المحاسبي (مُرحّل ✓)"
                          : order.expenseCategoryId
                          ? "معاينة وترحيل القيد"
                          : "ربط بالمصروفات"}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setPrescriptionOrder(order)}
                      className="flex items-center gap-1 rounded-xl border border-navy-200 bg-navy-50/70 px-2.5 py-1.5 text-xs font-bold text-navy-900 hover:bg-navy-100 shadow-2xs"
                      title="عرض وطباعة استمارة طلب المختبر الرسمية بمخطط الأسنان السريري"
                    >
                      <span>📋</span>
                      <span>استمارة المختبر</span>
                    </button>

                    {/* رحلة المريض V2 (§١٩): الطلب غير المُرسل يُرسل أو يُلغى من هنا. */}
                    {order.status === "needed" && (
                      <>
                        <button
                          type="button"
                          onClick={() => updateOrderStatus(order.id, "sent")}
                          disabled={busy}
                          className="rounded-xl bg-sky-600 px-3 py-1.5 text-xs font-bold text-white shadow-2xs hover:bg-sky-700 disabled:opacity-40"
                        >
                          📦 أُرسل للمعمل
                        </button>
                        <button
                          type="button"
                          onClick={() => updateOrderStatus(order.id, "cancelled")}
                          disabled={busy}
                          className="rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                        >
                          إلغاء
                        </button>
                      </>
                    )}

                    {order.status === "sent" && (
                      <>
                        {/* المختبرات السنية V2: مراحل التصنيع تُرى كما يراها المعمل. */}
                        <button
                          type="button"
                          onClick={() => updateOrderStatus(order.id, "in_progress")}
                          disabled={busy}
                          className="rounded-xl border border-violet-300 bg-violet-50 px-2.5 py-1.5 text-xs font-bold text-violet-800 hover:bg-violet-100 disabled:opacity-40"
                        >
                          ⚙️ بدأ المعمل التصنيع
                        </button>
                        <button
                          type="button"
                          onClick={() => updateOrderStatus(order.id, "received")}
                          disabled={busy}
                          className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white shadow-2xs hover:bg-emerald-700 disabled:opacity-40"
                        >
                          ✓ تم الاستلام من المعمل
                        </button>
                      </>
                    )}

                    {order.status === "in_progress" && (
                      <button
                        type="button"
                        onClick={() => updateOrderStatus(order.id, "received")}
                        disabled={busy}
                        className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white shadow-2xs hover:bg-emerald-700 disabled:opacity-40"
                      >
                        ✓ تم الاستلام من المعمل
                      </button>
                    )}

                    {order.status === "received" && (
                      <>
                        <button
                          type="button"
                          onClick={() => setDeliveryAppointmentOrder(order)}
                          className="flex items-center gap-1 rounded-xl border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-black text-blue-800 hover:bg-blue-100 shadow-2xs"
                          title="حجز موعد تسليم وتركيب العمل للمريض في جدول المواعيد"
                        >
                          <span>📅</span>
                          <span>حجز موعد تسليم</span>
                        </button>
                        {patientWa ? (
                          <a
                            href={`https://wa.me/${patientWa}?text=${encodeURIComponent(patientMsg)}`}
                            target="_blank"
                            rel="noopener"
                            className="rounded-xl bg-[#25D366] px-3 py-1.5 text-xs font-bold text-white shadow-2xs hover:opacity-90"
                          >
                            💬 إشعار المريض بالوصول
                          </a>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => updateOrderStatus(order.id, "delivered")}
                          disabled={busy}
                          className="rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-bold text-white shadow-2xs hover:opacity-90 disabled:opacity-40"
                        >
                          🦷 تم التركيب والتسليم
                        </button>
                        {/* المختبرات السنية V2: إعادة التصنيع — العمل المعيب يعود
                            للمعمل بطلبٍ جديد لا يُلغي الأثر القديم. */}
                        <button
                          type="button"
                          onClick={() => updateOrderStatus(order.id, "remake")}
                          disabled={busy}
                          className="rounded-xl border border-red-300 bg-red-50 px-2.5 py-1.5 text-xs font-bold text-red-700 hover:bg-red-100 disabled:opacity-40"
                        >
                          ↺ إعادة تصنيع
                        </button>
                      </>
                    )}

                    {order.status === "sent" && labWa && (
                      <a
                        href={`https://wa.me/${labWa}?text=${encodeURIComponent(labMsg)}`}
                        target="_blank"
                        rel="noopener"
                        className="rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
                      >
                        استعجال المعمل
                      </a>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* نافذة استمارة طلب المختبر الرسمية مع مخطط الأسنان السريري */}
      {prescriptionOrder && (
        <LabPrescriptionModal
          order={prescriptionOrder}
          clinicName={clinicName}
          clinicPhone={clinicPhone}
          onClose={() => setPrescriptionOrder(null)}
        />
      )}

      {/* نافذة تذكير وحجز موعد تسليم وتركيب التركيبة السنية */}
      {deliveryAppointmentOrder && (
        <LabDeliveryAppointmentModal
          order={deliveryAppointmentOrder}
          clinicName={clinicName}
          clinicPhone={clinicPhone}
          isOpen={true}
          onClose={() => setDeliveryAppointmentOrder(null)}
          onAppointmentBooked={() => {
            void load(false);
          }}
        />
      )}

      {/* نافذة الربط المحاسبي لتكلفة أمر المعمل ببنود المصروفات والترحيل النهائي */}
      {accountingOrder && (
        <LabOrderAccountingModal
          order={accountingOrder}
          onClose={() => setAccountingOrder(null)}
          onSaved={(updatedOrder) => {
            setFeed((prev) => ({
              ...prev,
              orders: prev.orders.map((o) => (o.id === updatedOrder.id ? updatedOrder : o)),
            }));
            setAccountingOrder(null);
          }}
          expenseCategories={expenseCategories}
          baseCurrency={isCurrency(baseSettingValue) ? baseSettingValue : "YER"}
        />
      )}
    </main>
  );
}
