"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { LabPricingReportModal } from "@/components/LabPricingReportModal";
import { type Currency, CURRENCIES, CURRENCY_LABEL, CURRENCY_SHORT, formatAmount, parseAmount, toInputAmount } from "@/lib/money";
import {
  type LabPricingRule,
  type LabService,
  type LabServiceCategory,
  type LabToothScope,
  LAB_SERVICE_CATEGORY_META,
  LAB_TOOTH_SCOPE_META,
} from "@/lib/lab";
import { clinicDateString } from "@/lib/schedule";

interface Laboratory {
  id: number;
  name: string;
  currency: Currency;
  isActive: boolean;
  deliveryDays: number;
}

export default function LabPricingPage() {
  const [rules, setRules] = useState<LabPricingRule[]>([]);
  const [services, setServices] = useState<LabService[]>([]);
  const [laboratories, setLaboratories] = useState<Laboratory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Filters & Views
  const [selectedLabId, setSelectedLabId] = useState<string>("all");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [selectedStatus, setSelectedStatus] = useState<"all" | "active" | "historical" | "future">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [viewGrouping, setViewGrouping] = useState<"by_lab" | "by_service" | "flat">("by_lab");

  // Modals
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isUpdateModalOpen, setIsUpdateModalOpen] = useState(false);
  const [isNewVersionModalOpen, setIsNewVersionModalOpen] = useState(false);
  const [isPrintReportOpen, setIsPrintReportOpen] = useState(false);
  const [printReportLabId, setPrintReportLabId] = useState<number | "all">("all");
  const [editingRule, setEditingRule] = useState<LabPricingRule | null>(null);
  const [historyServiceLab, setHistoryServiceLab] = useState<{ labId: number; serviceId: number; labName: string; serviceName: string } | null>(null);
  const [deleteConfirmRule, setDeleteConfirmRule] = useState<LabPricingRule | null>(null);

  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);

  // Services grouped by category for dropdowns
  const groupedServicesByCategory = useMemo(() => {
    const map: Record<LabServiceCategory, LabService[]> = {
      prostho: [],
      implant: [],
      ortho: [],
      restorative: [],
      appliance: [],
      other: [],
    };
    services.forEach((s) => {
      const cat = s.category || "other";
      if (!map[cat]) map[cat] = [];
      map[cat].push(s);
    });
    return map;
  }, [services]);

  // Form State
  const [formData, setFormData] = useState<{
    partyId: string;
    labServiceId: string;
    cost: string;
    costCurrency: Currency;
    effectiveFrom: string;
    effectiveTo: string;
    note: string;
    closePreviousRule: boolean;
  }>({
    partyId: "",
    labServiceId: "",
    cost: "",
    costCurrency: "YER",
    effectiveFrom: today,
    effectiveTo: "",
    note: "",
    closePreviousRule: true,
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pricingRes, servicesRes, labsRes] = await Promise.all([
        fetch("/api/lab/pricing", { cache: "no-store" }),
        fetch("/api/lab/services?all=1", { cache: "no-store" }),
        fetch("/api/laboratories", { cache: "no-store" }),
      ]);

      if (!pricingRes.ok || !servicesRes.ok || !labsRes.ok) {
        if (pricingRes.status === 401 || servicesRes.status === 401 || labsRes.status === 401) {
          window.location.assign("/login");
          return;
        }
        throw new Error("تعذّر تحميل بيانات التسعير والخدمات.");
      }

      const [pricingData, servicesData, labsData] = await Promise.all([
        pricingRes.json(),
        servicesRes.json(),
        labsRes.json(),
      ]);

      const fetchedRules = pricingData.rules || [];
      const fetchedServices = servicesData.services || [];
      const fetchedLabs = labsData.laboratories || [];

      setRules(fetchedRules);
      setServices(fetchedServices);
      setLaboratories(fetchedLabs);

      // Check if URL has ?new=1 or ?create=1 to automatically open modal
      if (typeof window !== "undefined") {
        const params = new URLSearchParams(window.location.search);
        if (params.get("new") === "1" || params.get("create") === "1" || params.get("action") === "new") {
          const defaultLabId = params.get("labId") ? Number(params.get("labId")) : undefined;
          const defaultServiceId = params.get("serviceId") ? Number(params.get("serviceId")) : undefined;
          const targetLab = defaultLabId ? fetchedLabs.find((l: Laboratory) => l.id === defaultLabId) : fetchedLabs[0];
          setFormData({
            partyId: defaultLabId ? String(defaultLabId) : targetLab ? String(targetLab.id) : "",
            labServiceId: defaultServiceId ? String(defaultServiceId) : fetchedServices[0] ? String(fetchedServices[0].id) : "",
            cost: "",
            costCurrency: targetLab ? targetLab.currency : "YER",
            effectiveFrom: clinicDateString(new Date(), "Asia/Aden"),
            effectiveTo: "",
            note: "",
            closePreviousRule: true,
          });
          setIsCreateModalOpen(true);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ غير متوقع.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Helpers to classify rule status
  const getRuleStatus = useCallback(
    (rule: LabPricingRule): "active" | "historical" | "future" => {
      if (rule.effectiveFrom > today) return "future";
      if (rule.effectiveTo && rule.effectiveTo < today) return "historical";
      return "active";
    },
    [today],
  );

  // Filtered Rules
  const filteredRules = useMemo(() => {
    return rules.filter((rule) => {
      // Lab filter
      if (selectedLabId !== "all" && String(rule.partyId) !== selectedLabId) {
        return false;
      }
      // Status filter
      const status = getRuleStatus(rule);
      if (selectedStatus !== "all" && status !== selectedStatus) {
        return false;
      }
      // Category filter
      const svc = services.find((s) => s.id === rule.labServiceId);
      if (selectedCategory !== "all" && svc && svc.category !== selectedCategory) {
        return false;
      }
      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const labMatch = (rule.partyName || "").toLowerCase().includes(q);
        const svcMatch = (rule.serviceName || "").toLowerCase().includes(q);
        const codeMatch = (svc?.code || "").toLowerCase().includes(q);
        const noteMatch = (rule.note || "").toLowerCase().includes(q);
        if (!labMatch && !svcMatch && !codeMatch && !noteMatch) {
          return false;
        }
      }
      return true;
    });
  }, [rules, selectedLabId, selectedStatus, selectedCategory, searchQuery, services, getRuleStatus]);

  // Statistics
  const stats = useMemo(() => {
    const totalRules = rules.length;
    const activeRules = rules.filter((r) => getRuleStatus(r) === "active").length;
    const uniqueLabsPriced = new Set(rules.map((r) => r.partyId)).size;
    const uniqueServicesPriced = new Set(rules.map((r) => r.labServiceId)).size;
    return { totalRules, activeRules, uniqueLabsPriced, uniqueServicesPriced };
  }, [rules, getRuleStatus]);

  // Grouped by Lab
  const groupedByLab = useMemo(() => {
    const map = new Map<number, { lab: Laboratory | { id: number; name: string; currency: Currency }; rules: LabPricingRule[] }>();
    filteredRules.forEach((rule) => {
      const lab = laboratories.find((l) => l.id === rule.partyId) || {
        id: rule.partyId,
        name: rule.partyName || `مختبر #${rule.partyId}`,
        currency: rule.costCurrency,
      };
      if (!map.has(rule.partyId)) {
        map.set(rule.partyId, { lab, rules: [] });
      }
      map.get(rule.partyId)!.rules.push(rule);
    });
    return Array.from(map.values());
  }, [filteredRules, laboratories]);

  // Handle open create modal
  const openCreateModal = (defaultLabId?: number, defaultServiceId?: number) => {
    const targetLab = defaultLabId ? laboratories.find((l) => l.id === defaultLabId) : laboratories[0];
    setFormData({
      partyId: defaultLabId ? String(defaultLabId) : targetLab ? String(targetLab.id) : "",
      labServiceId: defaultServiceId ? String(defaultServiceId) : services[0] ? String(services[0].id) : "",
      cost: "",
      costCurrency: targetLab ? targetLab.currency : "YER",
      effectiveFrom: today,
      effectiveTo: "",
      note: "",
      closePreviousRule: true,
    });
    setIsCreateModalOpen(true);
  };

  // Handle open new rate version (updating price starting from a date)
  const openNewRateVersion = (rule: LabPricingRule) => {
    const svc = services.find((s) => s.id === rule.labServiceId);
    setFormData({
      partyId: String(rule.partyId),
      labServiceId: String(rule.labServiceId),
      /* القاعدة مخزّنة بالوحدات الصغرى؛ الخانة تتوقع الكبرى — وإلا ضُرب
         السعر مئة ضعف عند كل تحديث للسعر. */
      cost: toInputAmount(rule.costMinor, rule.costCurrency),
      costCurrency: rule.costCurrency,
      effectiveFrom: today,
      effectiveTo: "",
      note: `تحديث سعر اعتباراً من ${today} (${svc?.name || ""})`,
      closePreviousRule: true,
    });
    setEditingRule(rule);
    setIsNewVersionModalOpen(true);
  };

  // Submit Create / New Version
  const handleSaveRule = async (isNewVersion = false) => {
    if (!formData.partyId || !formData.labServiceId) {
      setError("يرجى اختيار المختبر والخدمة.");
      return;
    }
    const costNum = Number(formData.cost);
    if (isNaN(costNum) || costNum < 0) {
      setError("يرجى إدخال مبلغ صحيح للتكلفة.");
      return;
    }
    if (!formData.effectiveFrom) {
      setError("يرجى تحديد تاريخ بدء السريان.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/lab/pricing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partyId: Number(formData.partyId),
          labServiceId: Number(formData.labServiceId),
          cost: costNum,
          costCurrency: formData.costCurrency,
          effectiveFrom: formData.effectiveFrom,
          effectiveTo: formData.effectiveTo ? formData.effectiveTo : null,
          note: formData.note.trim() || null,
          closePreviousRule: formData.closePreviousRule,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.message || "تعذّر حفظ قاعدة التسعير.");
      }

      setSuccess(isNewVersion ? "تم تحديث السعر وتسجيل السعر الجديد بنجاح مع حفظ تاريخ السعر القديم." : "تمت إضافة قاعدة التسعير بنجاح.");
      setTimeout(() => setSuccess(null), 4000);
      setIsCreateModalOpen(false);
      setIsNewVersionModalOpen(false);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ أثناء الحفظ.");
    } finally {
      setBusy(false);
    }
  };

  // Submit Edit Rule
  const handleEditRule = async () => {
    if (!editingRule) return;
    const costNum = Number(formData.cost);
    if (isNaN(costNum) || costNum < 0) {
      setError("يرجى إدخال مبلغ صحيح.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/lab/pricing/${editingRule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cost: costNum,
          costCurrency: formData.costCurrency,
          effectiveFrom: formData.effectiveFrom,
          effectiveTo: formData.effectiveTo ? formData.effectiveTo : null,
          note: formData.note.trim() || null,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.message || "تعذّر تعديل قاعدة التسعير.");
      }

      setSuccess("تم تعديل قاعدة التسعير بنجاح.");
      setTimeout(() => setSuccess(null), 3500);
      setIsUpdateModalOpen(false);
      setEditingRule(null);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ أثناء التعديل.");
    } finally {
      setBusy(false);
    }
  };

  // Submit Delete Rule
  const handleDeleteRule = async () => {
    if (!deleteConfirmRule) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/lab/pricing/${deleteConfirmRule.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.message || "تعذّر حذف قاعدة التسعير.");
      }
      setSuccess("تم حذف قاعدة التسعير بنجاح.");
      setTimeout(() => setSuccess(null), 3500);
      setDeleteConfirmRule(null);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ أثناء الحذف.");
    } finally {
      setBusy(false);
    }
  };

  // Open Edit Modal
  const openEditModal = (rule: LabPricingRule) => {
    setEditingRule(rule);
    setFormData({
      partyId: String(rule.partyId),
      labServiceId: String(rule.labServiceId),
      /* كذلك التعديل: تُملأ الخانة بالوحدات الكبرى ليُحفظ المبلغ كما هو. */
      cost: toInputAmount(rule.costMinor, rule.costCurrency),
      costCurrency: rule.costCurrency,
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: rule.effectiveTo || "",
      note: rule.note || "",
      closePreviousRule: false,
    });
    setIsUpdateModalOpen(true);
  };

  // History timeline for a specific service & lab
  const serviceHistoryRules = useMemo(() => {
    if (!historyServiceLab) return [];
    return rules
      .filter((r) => r.partyId === historyServiceLab.labId && r.labServiceId === historyServiceLab.serviceId)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  }, [rules, historyServiceLab]);

  return (
    <main className="mx-auto max-w-6xl p-4 pb-32">
      <PageHeader
        title="جدول تسعير خدمات المختبرات"
        subtitle="إدارة تسعير التركيبات والأجهزة السنية لكل مختبر مع تواريخ السريان وضمان سلامة وتاريخ الطلبات القديمة"
        links={[
          { href: "/settings", label: "عام" },
          { href: "/settings/laboratories", label: "المختبرات" },
          { href: "/settings/lab-services", label: "دليل الخدمات" },
          { href: "/settings/lab-pricing", label: "جدول التسعير", current: true },
          { href: "/settings/users", label: "المستخدمون" },
          { href: "/settings/audit", label: "سجل التدقيق" },
          { href: "/settings/export", label: "النسخ والتصدير" },
        ]}
      />

      {/* Notifications */}
      {error && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-red-200 bg-red-50 p-3.5 text-xs font-bold text-red-800">
          <div className="flex items-center gap-2">
            <span>⚠️</span>
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)} className="text-red-600 hover:text-red-900">
            ✕
          </button>
        </div>
      )}

      {success && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-xs font-bold text-emerald-800">
          <div className="flex items-center gap-2">
            <span>✓</span>
            <span>{success}</span>
          </div>
          <button onClick={() => setSuccess(null)} className="text-emerald-600 hover:text-emerald-900">
            ✕
          </button>
        </div>
      )}

      {/* Hero Stats */}
      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="text-[11px] font-bold text-slate-500">إجمالي قواعد التسعير</div>
          <div className="mt-1 text-2xl font-black text-navy-950">{stats.totalRules}</div>
          <div className="mt-1 text-[10px] text-slate-500">سجل شامل للأسعار الحالية والتاريخية</div>
        </div>

        <div className="rounded-2xl border border-emerald-100 bg-emerald-50/50 p-4 shadow-xs">
          <div className="text-[11px] font-bold text-emerald-800">الأسعار السارية اليوم</div>
          <div className="mt-1 text-2xl font-black text-emerald-900">{stats.activeRules}</div>
          <div className="mt-1 text-[10px] text-emerald-700">تُطبق آلياً عند إنشاء طلبات المعمل</div>
        </div>

        <div className="rounded-2xl border border-blue-100 bg-blue-50/50 p-4 shadow-xs">
          <div className="text-[11px] font-bold text-blue-800">المختبرات المسعرة</div>
          <div className="mt-1 text-2xl font-black text-blue-900">
            {stats.uniqueLabsPriced} <span className="text-xs font-normal text-blue-700">/ {laboratories.length} معمل</span>
          </div>
          <div className="mt-1 text-[10px] text-blue-700">مختبرات محددة بقوائم أسعار</div>
        </div>

        <div className="rounded-2xl border border-purple-100 bg-purple-50/50 p-4 shadow-xs">
          <div className="text-[11px] font-bold text-purple-800">الخدمات المغطاة</div>
          <div className="mt-1 text-2xl font-black text-purple-900">
            {stats.uniqueServicesPriced} <span className="text-xs font-normal text-purple-700">/ {services.length} خدمة</span>
          </div>
          <div className="mt-1 text-[10px] text-purple-700">تركيبات، زراعة، وتقويم مسعرة</div>
        </div>
      </section>

      {/* Action Banner & Historical Guarantee Notice */}
      <section className="mb-6 rounded-2xl border border-brand-blue/20 bg-gradient-to-l from-brand-blue/10 via-brand-blue/5 to-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-blue text-xs text-white font-bold">
                🛡️
              </span>
              <h2 className="text-sm font-black text-navy-950">ضمان النزاهة المالية وعدم المساس بالطلبات السابقة</h2>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              كل قاعدة تسعير تحمل <strong>تاريخ تفعيلها</strong>. عند تحديث الأسعار، يُسجل السعر الجديد مع تاريخ بدئه، بينما تظل كافة طلبات المختبر السابقة مسعرة بالتكلفة التاريخية التي كانت سارية وقت إرسالها دون أي تغيير.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => {
                setPrintReportLabId(selectedLabId === "all" ? "all" : Number(selectedLabId));
                setIsPrintReportOpen(true);
              }}
              className="flex items-center gap-2 rounded-xl border border-navy-900/30 bg-navy-900 px-4 py-2.5 text-xs font-black text-white shadow-md transition hover:bg-navy-800"
              title="توليد تقرير بصيغة A4 يعرض قائمة الأسعار الحالية والسارية لتقديمها للمختبر كمرجع رسمي"
            >
              <span>🖨️</span>
              <span>طباعة قائمة الأسعار السارية (A4)</span>
            </button>

            <button
              onClick={() => openCreateModal()}
              className="flex items-center gap-2 rounded-xl bg-brand-blue px-4 py-2.5 text-xs font-black text-white shadow-md transition hover:bg-brand-blue/90"
            >
              <span>+</span>
              <span>إضافة سعر خدمة جديد</span>
            </button>
          </div>
        </div>
      </section>

      {/* Search & Filter Toolbar */}
      <section className="mb-6 space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {/* Search */}
          <div>
            <label className="block text-[11px] font-bold text-slate-600 mb-1">بحث في الأسعار والخدمات</label>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="اسم المختبر، الخدمة، الكود..."
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-navy-900 focus:border-brand-blue focus:bg-white focus:outline-none"
            />
          </div>

          {/* Filter by Lab */}
          <div>
            <label className="block text-[11px] font-bold text-slate-600 mb-1">المختبر</label>
            <select
              value={selectedLabId}
              onChange={(e) => setSelectedLabId(e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-navy-900 focus:border-brand-blue focus:bg-white focus:outline-none"
            >
              <option value="all">جميع المختبرات ({laboratories.length})</option>
              {laboratories.map((lab) => (
                <option key={lab.id} value={lab.id}>
                  {lab.name} ({lab.currency})
                </option>
              ))}
            </select>
          </div>

          {/* Filter by Category */}
          <div>
            <label className="block text-[11px] font-bold text-slate-600 mb-1">تصنيف الخدمة</label>
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-navy-900 focus:border-brand-blue focus:bg-white focus:outline-none"
            >
              <option value="all">جميع التصنيفات</option>
              <option value="prostho">تركيبات سنية</option>
              <option value="implant">زراعة أسنان</option>
              <option value="ortho">تقويم أسنان</option>
              <option value="restorative">ترميمات ومعمل</option>
              <option value="appliance">أجهزة وجبائر</option>
              <option value="other">تشخيص وقوالب</option>
            </select>
          </div>

          {/* Filter by Status */}
          <div>
            <label className="block text-[11px] font-bold text-slate-600 mb-1">حالة السريان</label>
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value as any)}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-navy-900 focus:border-brand-blue focus:bg-white focus:outline-none"
            >
              <option value="all">جميع الحالات</option>
              <option value="active">السارية حالياً</option>
              <option value="historical">المنتهية والتاريخية</option>
              <option value="future">تبدأ مستقبلاً</option>
            </select>
          </div>
        </div>

        {/* View Layout Tabs */}
        <div className="flex flex-wrap items-center justify-between border-t border-slate-100 pt-3 gap-2">
          <div className="flex items-center gap-1">
            <span className="text-xs text-slate-500 font-bold ml-2">طريقة العرض:</span>
            <button
              onClick={() => setViewGrouping("by_lab")}
              className={`rounded-lg px-2.5 py-1 text-xs font-bold transition ${
                viewGrouping === "by_lab"
                  ? "bg-navy-900 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              مجمع حسب المختبر
            </button>
            <button
              onClick={() => setViewGrouping("flat")}
              className={`rounded-lg px-2.5 py-1 text-xs font-bold transition ${
                viewGrouping === "flat"
                  ? "bg-navy-900 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              جدول مسطح شامل
            </button>
          </div>

          <div className="text-xs text-slate-500 font-medium">
            عرض {filteredRules.length} من أصل {rules.length} قاعدة تسعير
          </div>
        </div>
      </section>

      {/* Main Content Area */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-400">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-blue border-t-transparent mb-3" />
          <p className="text-xs font-bold">جاري تحميل جدول التسعير وقواعد المعامل...</p>
        </div>
      ) : filteredRules.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white p-12 text-center">
          <span className="text-4xl">🏷️</span>
          <h3 className="mt-3 text-sm font-black text-navy-950">لا توجد قواعد تسعير مطابقة للفلاتر</h3>
          <p className="mt-1 text-xs text-slate-500 max-w-md mx-auto">
            {rules.length === 0
              ? "لم يتم تسجيل أي أسعار لخدمات المختبرات بعد. يمكنك البدء بإضافة الأسعار المعتمدة لكل مختبر."
              : "جرب تغيير خيارات التصفية أو مسح عبارة البحث للعثور على الأسعار المطلوبة."}
          </p>
          <div className="mt-4 flex justify-center gap-3">
            <button
              onClick={() => openCreateModal()}
              className="rounded-xl bg-brand-blue px-4 py-2 text-xs font-black text-white shadow-xs hover:bg-brand-blue/90"
            >
              + إضافة أول قاعدة تسعير
            </button>
          </div>
        </div>
      ) : viewGrouping === "by_lab" ? (
        /* Grouped View by Lab */
        <div className="space-y-6">
          {groupedByLab.map(({ lab, rules: labRules }) => (
            <div key={lab.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
              {/* Lab Card Header */}
              <div className="flex flex-wrap items-center justify-between border-b border-slate-100 bg-slate-50/80 px-4 py-3.5">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-blue/10 text-brand-blue font-black text-sm">
                    🧪
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-black text-navy-950">{lab.name}</h3>
                      <span className="rounded-md bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-700">
                        {lab.currency}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500">
                      {labRules.filter((r) => getRuleStatus(r) === "active").length} سعر سارٍ · {labRules.length} قاعدة إجمالية
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setPrintReportLabId(lab.id);
                      setIsPrintReportOpen(true);
                    }}
                    className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 shadow-2xs hover:bg-slate-50 hover:text-navy-950"
                    title={`طباعة تقرير A4 بقائمة أسعار ${lab.name} السارية فقط بدون المنتهية`}
                  >
                    <span>🖨️</span>
                    <span>طباعة الأسعار (A4)</span>
                  </button>

                  <button
                    onClick={() => openCreateModal(lab.id)}
                    className="flex items-center gap-1 rounded-lg border border-brand-blue/30 bg-white px-3 py-1.5 text-xs font-bold text-brand-blue shadow-2xs hover:bg-brand-blue/5"
                  >
                    <span>+</span>
                    <span>إضافة سعر لهذا المعمل</span>
                  </button>
                </div>
              </div>

              {/* Lab Rules Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-right text-xs">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/40 text-[11px] font-bold text-slate-500">
                      <th className="px-4 py-2.5">الخدمة السنية</th>
                      <th className="px-3 py-2.5">التصنيف والنطاق</th>
                      <th className="px-3 py-2.5 text-left">السعر / التكلفة</th>
                      <th className="px-3 py-2.5">تاريخ التفعيل (سارٍ من)</th>
                      <th className="px-3 py-2.5">تاريخ الانتهاء</th>
                      <th className="px-3 py-2.5 text-center">الحالة</th>
                      <th className="px-4 py-2.5 text-center">الإجراءات</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {labRules.map((rule) => {
                      const svc = services.find((s) => s.id === rule.labServiceId);
                      const status = getRuleStatus(rule);
                      const catMeta = svc?.category ? LAB_SERVICE_CATEGORY_META[svc.category] : null;
                      const scopeMeta = svc?.toothScope ? LAB_TOOTH_SCOPE_META[svc.toothScope] : null;

                      return (
                        <tr
                          key={rule.id}
                          className={`transition hover:bg-slate-50/70 ${
                            status === "historical" ? "opacity-60 bg-slate-50/30" : ""
                          }`}
                        >
                          {/* Service Name & Code */}
                          <td className="px-4 py-3">
                            <div className="font-bold text-navy-950">
                              {svc?.name || rule.serviceName || `خدمة #${rule.labServiceId}`}
                            </div>
                            {svc?.code && (
                              <span className="font-mono text-[10px] text-slate-400">#{svc.code}</span>
                            )}
                            {rule.note && (
                              <div className="text-[10px] text-slate-500 mt-0.5">💬 {rule.note}</div>
                            )}
                          </td>

                          {/* Category & Scope */}
                          <td className="px-3 py-3">
                            <div className="flex flex-wrap gap-1">
                              {catMeta && (
                                <span
                                  className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${catMeta.bg} ${catMeta.text}`}
                                >
                                  {catMeta.shortLabel}
                                </span>
                              )}
                              {scopeMeta && (
                                <span
                                  className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${scopeMeta.badgeBg}`}
                                >
                                  {scopeMeta.shortLabel}
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Cost */}
                          <td className="px-3 py-3 text-left font-mono font-bold text-navy-950">
                            <span className="text-sm">
                              {formatAmount(rule.costMinor, rule.costCurrency)}
                            </span>{" "}
                            <span className="text-[10px] font-sans text-slate-500">
                              {CURRENCY_LABEL[rule.costCurrency]}
                            </span>
                          </td>

                          {/* Effective From */}
                          <td className="px-3 py-3 font-mono text-[11px] text-slate-700">
                            {rule.effectiveFrom}
                          </td>

                          {/* Effective To */}
                          <td className="px-3 py-3 font-mono text-[11px] text-slate-600">
                            {rule.effectiveTo ? (
                              rule.effectiveTo
                            ) : (
                              <span className="text-slate-400 font-sans text-[10px]">مستمر (حالي)</span>
                            )}
                          </td>

                          {/* Status Badge */}
                          <td className="px-3 py-3 text-center">
                            {status === "active" && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-black text-emerald-800">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                سارٍ حالياً
                              </span>
                            )}
                            {status === "historical" && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                                منتهي
                              </span>
                            )}
                            {status === "future" && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-black text-blue-800">
                                يبدأ مستقبلاً
                              </span>
                            )}
                          </td>

                          {/* Actions */}
                          <td className="px-4 py-3 text-center">
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                onClick={() => openNewRateVersion(rule)}
                                title="تحديث السعر وتسجيل تاريخ تفعيل جديد"
                                className="rounded-lg bg-emerald-50 px-2 py-1 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100 transition"
                              >
                                ⚡ تحديث السعر
                              </button>

                              <button
                                onClick={() =>
                                  setHistoryServiceLab({
                                    labId: rule.partyId,
                                    serviceId: rule.labServiceId,
                                    labName: lab.name,
                                    serviceName: svc?.name || rule.serviceName || "",
                                  })
                                }
                                title="عرض السجل التاريخي لتغيرات السعر"
                                className="rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-700 hover:bg-slate-200 transition"
                              >
                                📜 السجل
                              </button>

                              <button
                                onClick={() => openEditModal(rule)}
                                title="تعديل بيانات السعر"
                                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-navy-900 transition"
                              >
                                ✏️
                              </button>

                              <button
                                onClick={() => setDeleteConfirmRule(rule)}
                                title="حذف قاعدة التسعير"
                                className="rounded-lg p-1 text-slate-400 hover:bg-red-50 hover:text-red-700 transition"
                              >
                                🗑️
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* Flat Table View */
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-[11px] font-bold text-slate-500">
                  <th className="px-4 py-3">المختبر</th>
                  <th className="px-4 py-3">الخدمة السنية</th>
                  <th className="px-3 py-3">التصنيف</th>
                  <th className="px-3 py-3 text-left">التكلفة / السعر</th>
                  <th className="px-3 py-3">تاريخ التفعيل</th>
                  <th className="px-3 py-3">تاريخ الانتهاء</th>
                  <th className="px-3 py-3 text-center">الحالة</th>
                  <th className="px-4 py-3 text-center">الإجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredRules.map((rule) => {
                  const svc = services.find((s) => s.id === rule.labServiceId);
                  const status = getRuleStatus(rule);
                  const catMeta = svc?.category ? LAB_SERVICE_CATEGORY_META[svc.category] : null;

                  return (
                    <tr
                      key={rule.id}
                      className={`transition hover:bg-slate-50/70 ${
                        status === "historical" ? "opacity-60 bg-slate-50/30" : ""
                      }`}
                    >
                      <td className="px-4 py-3 font-bold text-navy-950">
                        {rule.partyName || `مختبر #${rule.partyId}`}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-bold text-navy-950">
                          {svc?.name || rule.serviceName || `خدمة #${rule.labServiceId}`}
                        </div>
                        {svc?.code && <span className="font-mono text-[10px] text-slate-400">#{svc.code}</span>}
                      </td>
                      <td className="px-3 py-3">
                        {catMeta && (
                          <span
                            className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${catMeta.bg} ${catMeta.text}`}
                          >
                            {catMeta.shortLabel}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-left font-mono font-bold text-navy-950">
                        {formatAmount(rule.costMinor, rule.costCurrency)} {CURRENCY_SHORT[rule.costCurrency]}
                      </td>
                      <td className="px-3 py-3 font-mono text-[11px] text-slate-700">{rule.effectiveFrom}</td>
                      <td className="px-3 py-3 font-mono text-[11px] text-slate-600">
                        {rule.effectiveTo || "—"}
                      </td>
                      <td className="px-3 py-3 text-center">
                        {status === "active" && (
                          <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-black text-emerald-800">
                            سارٍ حالياً
                          </span>
                        )}
                        {status === "historical" && (
                          <span className="inline-flex rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                            منتهي
                          </span>
                        )}
                        {status === "future" && (
                          <span className="inline-flex rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-black text-blue-800">
                            مستقبلي
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={() => openNewRateVersion(rule)}
                            className="rounded-lg bg-emerald-50 px-2 py-1 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100"
                          >
                            تحديث السعر
                          </button>
                          <button
                            onClick={() => openEditModal(rule)}
                            className="rounded p-1 text-slate-400 hover:text-navy-900"
                          >
                            ✏️
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal: Create Pricing Rule */}
      {isCreateModalOpen && (() => {
        const selectedSvc = services.find((s) => String(s.id) === formData.labServiceId);
        const selectedLab = laboratories.find((l) => String(l.id) === formData.partyId);
        const costNum = Number(formData.cost);
        const isValidCost = !isNaN(costNum) && costNum >= 0 && formData.cost.trim() !== "";
        const svcCatMeta = selectedSvc ? LAB_SERVICE_CATEGORY_META[selectedSvc.category] : null;
        const svcScopeMeta = selectedSvc ? LAB_TOOTH_SCOPE_META[selectedSvc.toothScope] : null;

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/60 backdrop-blur-xs p-4 overflow-y-auto">
            <div className="my-8 w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl border border-slate-200">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-blue/10 text-brand-blue font-black text-sm">
                    🏷️
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-navy-950">إضافة قاعدة تسعير جديدة</h3>
                    <p className="text-[11px] text-slate-500">
                      تحديد سعر خدمة سنية لمعمل محدد مع تاريخ بدء السريان والعملة
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-navy-900"
                >
                  ✕
                </button>
              </div>

              <div className="mt-4 space-y-4 text-xs">
                {/* Lab Picker */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block font-bold text-slate-700">المختبر أو المعمل السني *</label>
                    {selectedLab && (
                      <span className="text-[10px] text-slate-500 font-semibold">
                        مدة التسليم المعتادة: {selectedLab.deliveryDays} أيام
                      </span>
                    )}
                  </div>
                  <select
                    value={formData.partyId}
                    onChange={(e) => {
                      const partyId = e.target.value;
                      const lab = laboratories.find((l) => l.id === Number(partyId));
                      setFormData((prev) => ({
                        ...prev,
                        partyId,
                        costCurrency: lab ? lab.currency : prev.costCurrency,
                      }));
                    }}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-xs font-bold text-navy-900 focus:border-brand-blue focus:bg-white focus:outline-none"
                  >
                    <option value="">-- اختر المختبر من القائمة المتاحة --</option>
                    {laboratories.map((lab) => (
                      <option key={lab.id} value={lab.id}>
                        {lab.name} — العملة الافتراضية: ({CURRENCY_LABEL[lab.currency]}) {!lab.isActive ? " [غير نشط]" : ""}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Service Picker (Categorized by Dental Specialty) */}
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    الخدمة السنية من الدليل المتاح *
                  </label>
                  <select
                    value={formData.labServiceId}
                    onChange={(e) => setFormData((prev) => ({ ...prev, labServiceId: e.target.value }))}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-xs font-bold text-navy-900 focus:border-brand-blue focus:bg-white focus:outline-none"
                  >
                    <option value="">-- اختر الخدمة السنية من الدليل المتاح --</option>

                    {/* Prosthodontics */}
                    {groupedServicesByCategory.prostho.length > 0 && (
                      <optgroup label="👑 تركيبات سنية">
                        {groupedServicesByCategory.prostho.map((svc) => (
                          <option key={svc.id} value={svc.id}>
                            {svc.name} {svc.code ? `[#${svc.code}]` : ""} — ({LAB_TOOTH_SCOPE_META[svc.toothScope]?.shortLabel})
                          </option>
                        ))}
                      </optgroup>
                    )}

                    {/* Implantology */}
                    {groupedServicesByCategory.implant.length > 0 && (
                      <optgroup label="🔩 زراعة أسنان">
                        {groupedServicesByCategory.implant.map((svc) => (
                          <option key={svc.id} value={svc.id}>
                            {svc.name} {svc.code ? `[#${svc.code}]` : ""} — ({LAB_TOOTH_SCOPE_META[svc.toothScope]?.shortLabel})
                          </option>
                        ))}
                      </optgroup>
                    )}

                    {/* Orthodontics */}
                    {groupedServicesByCategory.ortho.length > 0 && (
                      <optgroup label="🦷 تقويم أسنان">
                        {groupedServicesByCategory.ortho.map((svc) => (
                          <option key={svc.id} value={svc.id}>
                            {svc.name} {svc.code ? `[#${svc.code}]` : ""} — ({LAB_TOOTH_SCOPE_META[svc.toothScope]?.shortLabel})
                          </option>
                        ))}
                      </optgroup>
                    )}

                    {/* Restorative */}
                    {groupedServicesByCategory.restorative.length > 0 && (
                      <optgroup label="✨ ترميمات ومعمل">
                        {groupedServicesByCategory.restorative.map((svc) => (
                          <option key={svc.id} value={svc.id}>
                            {svc.name} {svc.code ? `[#${svc.code}]` : ""} — ({LAB_TOOTH_SCOPE_META[svc.toothScope]?.shortLabel})
                          </option>
                        ))}
                      </optgroup>
                    )}

                    {/* Appliances */}
                    {groupedServicesByCategory.appliance.length > 0 && (
                      <optgroup label="🛡️ أجهزة وجبائر">
                        {groupedServicesByCategory.appliance.map((svc) => (
                          <option key={svc.id} value={svc.id}>
                            {svc.name} {svc.code ? `[#${svc.code}]` : ""} — ({LAB_TOOTH_SCOPE_META[svc.toothScope]?.shortLabel})
                          </option>
                        ))}
                      </optgroup>
                    )}

                    {/* Other */}
                    {groupedServicesByCategory.other.length > 0 && (
                      <optgroup label="📦 تشخيص وقوالب وطبعات">
                        {groupedServicesByCategory.other.map((svc) => (
                          <option key={svc.id} value={svc.id}>
                            {svc.name} {svc.code ? `[#${svc.code}]` : ""} — ({LAB_TOOTH_SCOPE_META[svc.toothScope]?.shortLabel})
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>

                  {/* Selected Service Quick Specifications Card */}
                  {selectedSvc && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200/80 bg-slate-50 p-2.5">
                      <span className="font-bold text-navy-950">{selectedSvc.name}</span>
                      {selectedSvc.code && (
                        <span className="rounded bg-slate-200 px-1.5 py-0.5 font-mono text-[10px] text-slate-700 font-bold">
                          #{selectedSvc.code}
                        </span>
                      )}
                      {svcCatMeta && (
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${svcCatMeta.bg} ${svcCatMeta.text}`}>
                          {svcCatMeta.label}
                        </span>
                      )}
                      {svcScopeMeta && (
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${svcScopeMeta.badgeBg}`}>
                          {svcScopeMeta.label}
                        </span>
                      )}
                      <span className="text-[10px] text-slate-500 font-semibold">
                        ⏱️ مدة الإنجاز القياسية: {selectedSvc.defaultDays} أيام
                      </span>
                    </div>
                  )}
                </div>

                {/* Price (Amount) & Currency */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">سعر التكلفة (المبلغ) *</label>
                    <input
                      type="number"
                      value={formData.cost}
                      onChange={(e) => setFormData((prev) => ({ ...prev, cost: e.target.value }))}
                      placeholder="مثال: 15000"
                      min="0"
                      step="any"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 font-mono text-xs font-bold text-navy-950 focus:border-brand-blue focus:bg-white focus:outline-none"
                    />
                    {isValidCost && parseAmount(formData.cost, formData.costCurrency) !== null && (
                      <div className="mt-1 text-[11px] font-bold text-emerald-700 font-mono">
                        القيمة: {formatAmount(parseAmount(formData.cost, formData.costCurrency) ?? 0, formData.costCurrency)} {CURRENCY_LABEL[formData.costCurrency]}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block font-bold text-slate-700 mb-1">العملة *</label>
                    <select
                      value={formData.costCurrency}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, costCurrency: e.target.value as Currency }))
                      }
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-xs font-bold text-navy-900 focus:border-brand-blue focus:bg-white focus:outline-none"
                    >
                      {CURRENCIES.map((cur) => (
                        <option key={cur} value={cur}>
                          {CURRENCY_LABEL[cur]} ({cur})
                        </option>
                      ))}
                    </select>
                    <span className="text-[10px] text-slate-500 block mt-1">
                      العملة المعتمدة لمحاسبة المختبر على هذا البند
                    </span>
                  </div>
                </div>

                {/* Effective Dates (تاريخ السريان) */}
                <div className="rounded-2xl border border-slate-200 bg-slate-50/50 p-3.5 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-800 flex items-center gap-1.5">
                      <span>📅</span>
                      <span>فترة سريان السعر</span>
                    </span>
                    {/* Quick Date Presets */}
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setFormData((p) => ({ ...p, effectiveFrom: today }))}
                        className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-bold text-navy-900 hover:bg-slate-100"
                      >
                        اليوم
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const now = new Date();
                          const firstDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
                          setFormData((p) => ({ ...p, effectiveFrom: firstDay }));
                        }}
                        className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-bold text-navy-900 hover:bg-slate-100"
                      >
                        أول الشهر
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const now = new Date();
                          const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
                          const nextFirstDay = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;
                          setFormData((p) => ({ ...p, effectiveFrom: nextFirstDay }));
                        }}
                        className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-bold text-navy-900 hover:bg-slate-100"
                      >
                        الشهر القادم
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-bold text-slate-700 mb-1">تاريخ بدء السريان (سارٍ من) *</label>
                      <input
                        type="date"
                        value={formData.effectiveFrom}
                        onChange={(e) => setFormData((prev) => ({ ...prev, effectiveFrom: e.target.value }))}
                        className="w-full rounded-xl border border-slate-200 bg-white p-2.5 font-mono text-xs text-navy-900 focus:border-brand-blue focus:outline-none"
                      />
                      <span className="text-[10px] text-slate-500 block mt-0.5">
                        الطلبات المرسلة ابتداءً من هذا التاريخ ستعتمد هذا السعر
                      </span>
                    </div>

                    <div>
                      <label className="block font-bold text-slate-700 mb-1">تاريخ الانتهاء (اختياري)</label>
                      <input
                        type="date"
                        value={formData.effectiveTo}
                        onChange={(e) => setFormData((prev) => ({ ...prev, effectiveTo: e.target.value }))}
                        className="w-full rounded-xl border border-slate-200 bg-white p-2.5 font-mono text-xs text-navy-900 focus:border-brand-blue focus:outline-none"
                      />
                      <span className="text-[10px] text-slate-500 block mt-0.5">
                        اتركه فارغاً ليستمر السعر سارياً بلا نهاية
                      </span>
                    </div>
                  </div>

                  {/* Auto close previous rule option */}
                  <label className="flex items-center gap-2 rounded-xl border border-slate-200/80 bg-white p-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.closePreviousRule}
                      onChange={(e) => setFormData((prev) => ({ ...prev, closePreviousRule: e.target.checked }))}
                      className="rounded text-brand-blue"
                    />
                    <span className="text-xs text-slate-700">
                      إغلاق السعر السابق تلقائياً بتاريخ اليوم السابق لمنع تداخل الفترات والحفاظ على سجل الأسعار التاريخية
                    </span>
                  </label>
                </div>

                {/* Note */}
                <div>
                  <label className="block font-bold text-slate-700 mb-1">ملاحظات وشروط الاتفاقية</label>
                  <input
                    type="text"
                    value={formData.note}
                    onChange={(e) => setFormData((prev) => ({ ...prev, note: e.target.value }))}
                    placeholder="مثال: خصم كميات، يشمل الطبعة الرقمية، ضمان 5 سنوات..."
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-xs text-navy-900 focus:border-brand-blue focus:bg-white focus:outline-none"
                  />
                </div>
              </div>

              <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  onClick={() => handleSaveRule(false)}
                  disabled={busy}
                  className="rounded-xl bg-brand-blue px-5 py-2 text-xs font-black text-white shadow-xs hover:bg-brand-blue/90 disabled:opacity-50"
                >
                  {busy ? "جاري الحفظ..." : "حفظ وتفعيل قاعدة التسعير"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Modal: New Price Rate Version (تحديث السعر مع تفعيل تاريخ جديد) */}
      {isNewVersionModalOpen && editingRule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-black text-navy-950">تحديث سعر الخدمة (تسجيل سعر جديد)</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  المختبر: <strong>{editingRule.partyName}</strong> · الخدمة: <strong>{editingRule.serviceName}</strong>
                </p>
              </div>
              <button
                onClick={() => setIsNewVersionModalOpen(false)}
                className="text-slate-400 hover:text-navy-900"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-4 text-xs">
              <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-amber-900">
                <div className="font-bold text-[11px] flex items-center gap-1.5">
                  <span>💡</span>
                  <span>السعر الساري حالياً: {formatAmount(editingRule.costMinor, editingRule.costCurrency)} {CURRENCY_SHORT[editingRule.costCurrency]} (منذ {editingRule.effectiveFrom})</span>
                </div>
                <p className="text-[10px] text-amber-800 mt-1">
                  إدخال السعر الجديد سيحفظ السعر القديم كما هو لكافة الطلبات السابقة، وسيبدأ تطبيق السعر الجديد فقط للطلبات المرسلة ابتداءً من تاريخ التفعيل المختار أدناه.
                </p>
              </div>

              {/* Price & Currency */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">السعر الجديد *</label>
                  <input
                    type="number"
                    value={formData.cost}
                    onChange={(e) => setFormData((prev) => ({ ...prev, cost: e.target.value }))}
                    placeholder="المبلغ الجديد"
                    min="0"
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 font-mono text-xs text-navy-900 focus:border-brand-blue focus:bg-white focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-bold text-slate-700 mb-1">العملة</label>
                  <select
                    value={formData.costCurrency}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, costCurrency: e.target.value as Currency }))
                    }
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-xs text-navy-900 focus:border-brand-blue focus:bg-white focus:outline-none"
                  >
                    {CURRENCIES.map((cur) => (
                      <option key={cur} value={cur}>
                        {CURRENCY_LABEL[cur]} ({cur})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Effective From */}
              <div>
                <label className="block font-bold text-slate-700 mb-1">تاريخ سريان وتطبيق السعر الجديد *</label>
                <input
                  type="date"
                  value={formData.effectiveFrom}
                  onChange={(e) => setFormData((prev) => ({ ...prev, effectiveFrom: e.target.value }))}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 font-mono text-xs text-navy-900 focus:border-brand-blue focus:bg-white focus:outline-none"
                />
                <span className="text-[10px] text-slate-500">
                  الطلبات المنشأة قبل هذا التاريخ ستعتمد السعر القديم تلقائياً
                </span>
              </div>

              {/* Note */}
              <div>
                <label className="block font-bold text-slate-700 mb-1">سبب أو ملاحظة التعديل</label>
                <input
                  type="text"
                  value={formData.note}
                  onChange={(e) => setFormData((prev) => ({ ...prev, note: e.target.value }))}
                  placeholder="مثال: زيادة في تكلفة المواد، تسعيرة سنوية جديدة..."
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-xs text-navy-900 focus:border-brand-blue focus:bg-white focus:outline-none"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-3">
              <button
                type="button"
                onClick={() => setIsNewVersionModalOpen(false)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
              >
                إلغاء
              </button>
              <button
                type="button"
                onClick={() => handleSaveRule(true)}
                disabled={busy}
                className="rounded-xl bg-emerald-600 px-5 py-2 text-xs font-black text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy ? "جاري الاعتماد..." : "اعتماد السعر الجديد"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Edit Existing Rule */}
      {isUpdateModalOpen && editingRule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-sm font-black text-navy-950">تعديل بيانات قاعدة التسعير</h3>
              <button
                onClick={() => setIsUpdateModalOpen(false)}
                className="text-slate-400 hover:text-navy-900"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-4 text-xs">
              <div className="rounded-xl bg-slate-50 p-3 text-slate-700">
                <div className="font-bold text-xs">{editingRule.partyName}</div>
                <div className="text-[11px] text-slate-500 mt-0.5">{editingRule.serviceName}</div>
              </div>

              {/* Price & Currency */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">المبلغ / التكلفة *</label>
                  <input
                    type="number"
                    value={formData.cost}
                    onChange={(e) => setFormData((prev) => ({ ...prev, cost: e.target.value }))}
                    min="0"
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 font-mono text-xs text-navy-900 focus:border-brand-blue focus:bg-white focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-bold text-slate-700 mb-1">العملة</label>
                  <select
                    value={formData.costCurrency}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, costCurrency: e.target.value as Currency }))
                    }
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-xs text-navy-900 focus:border-brand-blue focus:bg-white focus:outline-none"
                  >
                    {CURRENCIES.map((cur) => (
                      <option key={cur} value={cur}>
                        {CURRENCY_LABEL[cur]} ({cur})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Effective Dates */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">تاريخ بدء السريان</label>
                  <input
                    type="date"
                    value={formData.effectiveFrom}
                    onChange={(e) => setFormData((prev) => ({ ...prev, effectiveFrom: e.target.value }))}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 font-mono text-xs text-navy-900 focus:border-brand-blue focus:bg-white focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-bold text-slate-700 mb-1">تاريخ انتهاء السريان</label>
                  <input
                    type="date"
                    value={formData.effectiveTo}
                    onChange={(e) => setFormData((prev) => ({ ...prev, effectiveTo: e.target.value }))}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 font-mono text-xs text-navy-900 focus:border-brand-blue focus:bg-white focus:outline-none"
                  />
                </div>
              </div>

              {/* Note */}
              <div>
                <label className="block font-bold text-slate-700 mb-1">ملاحظات</label>
                <input
                  type="text"
                  value={formData.note}
                  onChange={(e) => setFormData((prev) => ({ ...prev, note: e.target.value }))}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-xs text-navy-900 focus:border-brand-blue focus:bg-white focus:outline-none"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-3">
              <button
                type="button"
                onClick={() => setIsUpdateModalOpen(false)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
              >
                إلغاء
              </button>
              <button
                type="button"
                onClick={handleEditRule}
                disabled={busy}
                className="rounded-xl bg-brand-blue px-5 py-2 text-xs font-black text-white hover:bg-brand-blue/90 disabled:opacity-50"
              >
                {busy ? "جاري التعديل..." : "حفظ التعديلات"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Service History Timeline */}
      {historyServiceLab && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-black text-navy-950">السجل التاريخي لأسعار الخدمة</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {historyServiceLab.labName} — {historyServiceLab.serviceName}
                </p>
              </div>
              <button
                onClick={() => setHistoryServiceLab(null)}
                className="text-slate-400 hover:text-navy-900"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 max-h-[60vh] overflow-y-auto space-y-3">
              {serviceHistoryRules.map((hr, idx) => {
                const status = getRuleStatus(hr);
                return (
                  <div
                    key={hr.id}
                    className={`relative rounded-xl border p-3.5 transition ${
                      status === "active"
                        ? "border-emerald-200 bg-emerald-50/50"
                        : "border-slate-200 bg-white opacity-80"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-black text-navy-950">
                          {formatAmount(hr.costMinor, hr.costCurrency)} {CURRENCY_LABEL[hr.costCurrency]}
                        </span>
                        {status === "active" ? (
                          <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-black text-emerald-800">
                            السعر الساري حالياً
                          </span>
                        ) : (
                          <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                            فترة سابقة
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-slate-400">بواسطة: {hr.createdBy}</span>
                    </div>

                    <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-600">
                      <div>
                        <strong>تاريخ السريان:</strong> {hr.effectiveFrom}
                      </div>
                      <div>
                        <strong>تاريخ الانتهاء:</strong> {hr.effectiveTo || "مستمر"}
                      </div>
                    </div>

                    {hr.note && (
                      <div className="mt-2 text-[10px] text-slate-500 bg-white/70 rounded p-1.5 border border-slate-100">
                        {hr.note}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex justify-end border-t border-slate-100 pt-3">
              <button
                type="button"
                onClick={() => setHistoryServiceLab(null)}
                className="rounded-xl bg-slate-100 px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-200"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Delete Confirmation */}
      {deleteConfirmRule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl">
            <h3 className="text-sm font-black text-navy-950">تأكيد حذف قاعدة التسعير</h3>
            <p className="mt-2 text-xs text-slate-600">
              هل أنت متأكد من حذف قاعدة تسعير <strong>{deleteConfirmRule.serviceName}</strong> للمختبر <strong>{deleteConfirmRule.partyName}</strong>؟
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirmRule(null)}
                className="rounded-xl border border-slate-200 px-3.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
              >
                إلغاء
              </button>
              <button
                type="button"
                onClick={handleDeleteRule}
                disabled={busy}
                className="rounded-xl bg-red-600 px-4 py-1.5 text-xs font-black text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy ? "جاري الحذف..." : "تأكيد الحذف"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Lab Pricing Official Report (A4 Printable Reference) */}
      {isPrintReportOpen && (
        <LabPricingReportModal
          laboratories={laboratories}
          services={services}
          rules={rules}
          initialLabId={printReportLabId}
          onClose={() => setIsPrintReportOpen(false)}
        />
      )}
    </main>
  );
}
