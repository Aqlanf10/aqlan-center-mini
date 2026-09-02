"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import {
  type LabService,
  type LabServiceCategory,
  type LabToothScope,
  LAB_SERVICE_CATEGORY_META,
  LAB_TOOTH_SCOPE_META,
} from "@/lib/lab";

const CATEGORIES: LabServiceCategory[] = [
  "prostho",
  "implant",
  "ortho",
  "restorative",
  "appliance",
  "other",
];

const TOOTH_SCOPES: LabToothScope[] = [
  "single_tooth",
  "multi_teeth_bridge",
  "full_arch",
  "general",
];

const DELIVERY_PRESETS = [2, 3, 5, 6, 7, 8, 10, 14];

export default function LabServicesSettingsPage() {
  const [services, setServices] = useState<LabService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");

  // Search & Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingService, setEditingService] = useState<LabService | null>(null);
  const [deleteConfirmService, setDeleteConfirmService] = useState<LabService | null>(null);
  const [isSeeding, setIsSeeding] = useState(false);

  // Form State
  const [formData, setFormData] = useState<{
    name: string;
    code: string;
    category: LabServiceCategory;
    toothScope: LabToothScope;
    requiresShade: boolean;
    defaultDays: number;
    description: string;
    sortOrder: number;
    isActive: boolean;
  }>({
    name: "",
    code: "",
    category: "prostho",
    toothScope: "single_tooth",
    requiresShade: true,
    defaultDays: 5,
    description: "",
    sortOrder: 50,
    isActive: true,
  });

  const loadServices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/lab/services?all=1");
      if (!res.ok) {
        if (res.status === 401) {
          window.location.assign("/login");
          return;
        }
        const err = await res.json().catch(() => null);
        throw new Error(err?.message || "تعذّر تحميل دليل خدمات المختبر.");
      }
      const data = await res.json();
      setServices(data.services || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ غير متوقع.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadServices();
  }, [loadServices]);

  const openCreateModal = () => {
    setEditingService(null);
    setFormData({
      name: "",
      code: "",
      category: "prostho",
      toothScope: "single_tooth",
      requiresShade: true,
      defaultDays: 5,
      description: "",
      sortOrder: (services.length + 1) * 10,
      isActive: true,
    });
    setIsModalOpen(true);
  };

  const openEditModal = (service: LabService) => {
    setEditingService(service);
    setFormData({
      name: service.name,
      code: service.code || "",
      category: service.category || "prostho",
      toothScope: service.toothScope || "single_tooth",
      requiresShade: service.requiresShade ?? true,
      defaultDays: service.defaultDays || 5,
      description: service.description || "",
      sortOrder: service.sortOrder || 100,
      isActive: service.isActive,
    });
    setIsModalOpen(true);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      setError("يرجى إدخال اسم خدمة المختبر.");
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);

    try {
      const url = editingService
        ? `/api/lab/services/${editingService.id}`
        : "/api/lab/services";
      const method = editingService ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name.trim(),
          code: formData.code.trim() || null,
          category: formData.category,
          toothScope: formData.toothScope,
          requiresShade: formData.requiresShade,
          defaultDays: Number(formData.defaultDays) || 5,
          description: formData.description.trim() || null,
          sortOrder: Number(formData.sortOrder) || 100,
          isActive: formData.isActive,
        }),
      });

      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.message || "تعذّر حفظ بيانات الخدمة.");
      }

      setSuccess(
        editingService
          ? `تم تحديث خدمة "${formData.name}" بنجاح.`
          : `تمت إضافة خدمة "${formData.name}" بنجاح.`,
      );
      setIsModalOpen(false);
      await loadServices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ أثناء الحفظ.");
    } finally {
      setBusy(false);
    }
  };

  // تبديل حالة التفعيل / التعطيل السريع بنقرة واحدة
  const toggleServiceStatus = async (service: LabService) => {
    const newStatus = !service.isActive;
    // تحديث تفاؤلي سريع
    setServices((prev) =>
      prev.map((s) => (s.id === service.id ? { ...s, isActive: newStatus } : s)),
    );

    try {
      const res = await fetch(`/api/lab/services/${service.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: newStatus }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.message || "تعذّر تحديث حالة الخدمة.");
      }
      setSuccess(
        newStatus
          ? `تم تفعيل خدمة "${service.name}" وأصبحت متاحة للطلب.`
          : `تم تعطيل خدمة "${service.name}" وحجبها عن شاشات الطلب الجديدة.`,
      );
    } catch (err) {
      // التراجع عن التحديث التفاؤلي
      setServices((prev) =>
        prev.map((s) => (s.id === service.id ? { ...s, isActive: service.isActive } : s)),
      );
      setError(err instanceof Error ? err.message : "تعذّر تحديث الحالة.");
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirmService) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/lab/services/${deleteConfirmService.id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.message || "تعذّر حذف أو تعطيل الخدمة.");
      }
      setSuccess(data.message || "تمت العملية بنجاح.");
      setDeleteConfirmService(null);
      await loadServices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر إتمام الحذف.");
    } finally {
      setBusy(false);
    }
  };

  // إعادة تحميل / بذر الدليل الافتراضي
  const handleSeedDefaults = async () => {
    if (
      !window.confirm(
        "هل ترغب في تحديث وبذر خدمات المختبر القياسية المعتمدة (تيجان زيركون، إيماكس، جسور، تقويم، زراعة) في الدليل؟",
      )
    ) {
      return;
    }
    setIsSeeding(true);
    setError(null);
    try {
      const res = await fetch("/api/lab/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "seed_defaults" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.message || "تعذّر بذر خدمات المختبر.");
      }
      setSuccess(data.message || "تم تحديث دليل خدمات المختبر بنجاح.");
      await loadServices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر تحديث الدليل الافتراضي.");
    } finally {
      setIsSeeding(false);
    }
  };

  // Filtered Services
  const filteredServices = useMemo(() => {
    return services.filter((svc) => {
      if (statusFilter === "active" && !svc.isActive) return false;
      if (statusFilter === "inactive" && svc.isActive) return false;
      if (categoryFilter !== "all" && svc.category !== categoryFilter) return false;
      if (scopeFilter !== "all" && svc.toothScope !== scopeFilter) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchesName = svc.name.toLowerCase().includes(q);
        const matchesCode = (svc.code || "").toLowerCase().includes(q);
        const matchesDesc = (svc.description || "").toLowerCase().includes(q);
        const catMeta = LAB_SERVICE_CATEGORY_META[svc.category];
        const matchesCat = catMeta?.label.toLowerCase().includes(q);
        if (!matchesName && !matchesCode && !matchesDesc && !matchesCat) {
          return false;
        }
      }
      return true;
    });
  }, [services, searchQuery, categoryFilter, scopeFilter, statusFilter]);

  // Statistics
  const stats = useMemo(() => {
    const total = services.length;
    const active = services.filter((s) => s.isActive).length;
    const inactive = total - active;
    const toothLinked = services.filter(
      (s) => s.toothScope === "single_tooth" || s.toothScope === "multi_teeth_bridge",
    ).length;
    const avgDelivery =
      total > 0
        ? Math.round(services.reduce((acc, s) => acc + (s.defaultDays || 5), 0) / total)
        : 0;
    return { total, active, inactive, toothLinked, avgDelivery };
  }, [services]);

  return (
    <main className="mx-auto max-w-6xl p-4 pb-24 text-slate-800" dir="rtl">
      <PageHeader
        title="دليل خدمات المختبرات السنية (Lab Service Catalog)"
        subtitle="إدارة وتصنيف الأعمال المعملية، ربطها بمخطط الأسنان السريري، مدد الإنجاز، وتمكين وتعطيل الخدمات"
        links={[
          { href: "/settings", label: "عام" },
          { href: "/settings/laboratories", label: "المختبرات" },
          { href: "/settings/lab-services", label: "دليل خدمات المختبر", current: true },
          { href: "/settings/lab-pricing", label: "جدول التسعير" },
          { href: "/settings/users", label: "المستخدمون والصلاحيات" },
          { href: "/settings/audit", label: "سجل التدقيق" },
          { href: "/settings/export", label: "النسخ والتصدير" },
          { href: "/settings/ai", label: "الذكاء الاصطناعي" },
        ]}
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleSeedDefaults}
            disabled={isSeeding || busy}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-xs transition hover:bg-slate-50 disabled:opacity-50"
            title="تحديث أو استيراد الخدمات القياسية (زيركون، إيماكس، تقويم، زراعة)"
          >
            <Icon name="refresh" className={`h-4 w-4 ${isSeeding ? "animate-spin text-brand-orange" : "text-slate-500"}`} />
            <span>بذر الدليل القياسي</span>
          </button>
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center gap-2 rounded-xl bg-brand-orange px-4 py-2.5 text-xs font-extrabold text-white shadow-sm transition hover:opacity-95"
          >
            <Icon name="plus" className="h-4 w-4" />
            <span>إضافة خدمة جديدة</span>
          </button>
        </div>
      </PageHeader>

      {/* Navigation Sub-Tabs between Laboratories, Catalog, and Central Pricing */}
      <div className="mb-6 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50/80 p-1.5 shadow-xs">
        <Link
          href="/settings/laboratories"
          className="flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-xs font-bold text-slate-600 transition hover:bg-white hover:text-slate-900"
        >
          <Icon name="briefcase" className="h-4 w-4" />
          <span>المختبرات وفنيو التركيبات</span>
        </Link>
        <Link
          href="/settings/lab-services"
          className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-white py-2.5 text-xs font-extrabold text-brand-blue shadow-xs"
        >
          <Icon name="tag" className="h-4 w-4 text-brand-orange" />
          <span>دليل خدمات المختبر (Catalog)</span>
          <span className="rounded-full bg-brand-blue/10 px-2 py-0.5 text-[10px] font-black text-brand-blue">
            {services.length}
          </span>
        </Link>
        <Link
          href="/settings/lab-pricing"
          className="flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-xs font-bold text-slate-600 transition hover:bg-white hover:text-emerald-700"
        >
          <span className="text-sm">🏷️</span>
          <span>جدول التسعير المركزي</span>
        </Link>
      </div>

      {/* Alert Banners */}
      {error && (
        <div
          role="alert"
          className="mb-4 flex items-center justify-between gap-2 rounded-xl border border-danger-300 bg-danger-50 px-4 py-3 text-sm font-bold text-danger-800"
        >
          <div className="flex items-center gap-2">
            <Icon name="alert" className="h-5 w-5 text-danger-600" />
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)} className="text-danger-500 hover:text-danger-800">
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>
      )}

      {success && (
        <div
          role="status"
          className="mb-4 flex items-center justify-between gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800"
        >
          <div className="flex items-center gap-2">
            <Icon name="check" className="h-5 w-5 text-emerald-600" />
            <span>{success}</span>
          </div>
          <button onClick={() => setSuccess(null)} className="text-emerald-500 hover:text-emerald-800">
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* KPI Overview */}
      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5" aria-label="إحصائيات سريعة">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="text-[11px] font-bold text-slate-500">إجمالي الخدمات</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-black text-slate-900">{stats.total}</span>
            <span className="text-[11px] text-slate-400">خدمة بالدليل</span>
          </div>
        </div>
        <div className="rounded-2xl border border-emerald-200/70 bg-emerald-50/40 p-4 shadow-xs">
          <div className="text-[11px] font-bold text-emerald-800">الخدمات النشطة</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-black text-emerald-700">{stats.active}</span>
            <span className="text-[11px] text-emerald-600">متاحة للطلب</span>
          </div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="text-[11px] font-bold text-slate-500">الخدمات المعطلة</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-black text-slate-600">{stats.inactive}</span>
            <span className="text-[11px] text-slate-400">محجوبة</span>
          </div>
        </div>
        <div className="rounded-2xl border border-blue-200/70 bg-blue-50/40 p-4 shadow-xs">
          <div className="text-[11px] font-bold text-blue-800">مرتبطة بالأسنان / التيجان</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-black text-blue-700">{stats.toothLinked}</span>
            <span className="text-[11px] text-blue-600">سن / جسر</span>
          </div>
        </div>
        <div className="col-span-2 rounded-2xl border border-amber-200/70 bg-amber-50/40 p-4 shadow-xs sm:col-span-1">
          <div className="text-[11px] font-bold text-amber-800">متوسط الإنجاز</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-black text-amber-700">{stats.avgDelivery}</span>
            <span className="text-[11px] text-amber-600">أيام عمل</span>
          </div>
        </div>
      </section>

      {/* Category Pills Bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setCategoryFilter("all")}
          className={`rounded-xl px-3.5 py-1.5 text-xs font-bold transition ${
            categoryFilter === "all"
              ? "bg-slate-900 text-white shadow-xs"
              : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          }`}
        >
          جميع التصنيفات ({services.length})
        </button>
        {CATEGORIES.map((cat) => {
          const meta = LAB_SERVICE_CATEGORY_META[cat];
          const count = services.filter((s) => s.category === cat).length;
          const isSelected = categoryFilter === cat;
          return (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold transition ${
                isSelected
                  ? `${meta.bg} ${meta.text} ring-2 ring-brand-blue/30 border ${meta.border} font-extrabold shadow-xs`
                  : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              <span>{meta.shortLabel}</span>
              <span className={`rounded-full px-1.5 py-0.2 text-[10px] ${isSelected ? "bg-white/80 font-black" : "bg-slate-100 text-slate-500"}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Filter & Search Bar */}
      <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          {/* Search Input */}
          <div className="relative flex-1">
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3.5 text-slate-400">
              <Icon name="search" className="h-4 w-4" />
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="ابحث باسم الخدمة (مثل: Full Zirconia, E.max)، الرمز، أو الوصف..."
              className="w-full rounded-xl border border-slate-200 bg-slate-50/50 py-2.5 pr-10 pl-3 text-xs text-slate-800 placeholder:text-slate-400 focus:border-brand-blue focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-blue"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400 hover:text-slate-600"
              >
                <Icon name="close" className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Filters & View Toggle */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Tooth Scope Filter */}
            <select
              value={scopeFilter}
              onChange={(e) => setScopeFilter(e.target.value)}
              className="rounded-xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-xs font-bold text-slate-700 focus:border-brand-blue focus:bg-white focus:outline-none"
            >
              <option value="all">ارتباط مخطط الأسنان: الكل</option>
              <option value="single_tooth">🦷 سن مفرد (Single Tooth)</option>
              <option value="multi_teeth_bridge">🔗 جسر / متعدد الأسنان (Bridge)</option>
              <option value="full_arch">👄 فك كامل / قوس (Full Arch)</option>
              <option value="general">📋 عام / غير مقيد بسن (General)</option>
            </select>

            {/* Status Filter */}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="rounded-xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-xs font-bold text-slate-700 focus:border-brand-blue focus:bg-white focus:outline-none"
            >
              <option value="all">الحالة: الكل</option>
              <option value="active">✓ النشطة والمتاحة فقط</option>
              <option value="inactive">✕ المعطلة فقط</option>
            </select>

            {/* View Switcher */}
            <div className="inline-flex rounded-xl border border-slate-200 bg-slate-100 p-0.5">
              <button
                type="button"
                onClick={() => setViewMode("grid")}
                className={`rounded-lg p-1.5 transition ${
                  viewMode === "grid"
                    ? "bg-white text-brand-blue shadow-xs"
                    : "text-slate-500 hover:text-slate-800"
                }`}
                title="عرض بطاقات تفاعلية"
              >
                <Icon name="menu" className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode("table")}
                className={`rounded-lg p-1.5 transition ${
                  viewMode === "table"
                    ? "bg-white text-brand-blue shadow-xs"
                    : "text-slate-500 hover:text-slate-800"
                }`}
                title="عرض جدول تفصيلي"
              >
                <Icon name="clipboard" className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Services List / Cards */}
      {loading ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white p-12 text-slate-400">
          <Icon name="refresh" className="h-8 w-8 animate-spin text-brand-orange" />
          <p className="mt-3 text-sm font-bold">جاري تحميل دليل خدمات المختبر...</p>
        </div>
      ) : filteredServices.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center text-slate-500">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
            <Icon name="tag" className="h-7 w-7" />
          </div>
          <h3 className="mt-4 text-base font-extrabold text-slate-900">
            {searchQuery || categoryFilter !== "all" || scopeFilter !== "all" || statusFilter !== "all"
              ? "لا توجد خدمات تطابق خيارات البحث والفلترة"
              : "دليل خدمات المختبر فارغ حالياً"}
          </h3>
          <p className="mt-1.5 max-w-md text-xs text-slate-500">
            {searchQuery || categoryFilter !== "all" || scopeFilter !== "all" || statusFilter !== "all"
              ? "جرّب تغيير كلمات البحث أو إعادة ضبط الفلاتر لعرض الخدمات المتاحة."
              : "يمكنك إضافة خدمة معملية جديدة أو النقر على 'بذر الدليل القياسي' لتحميل الخدمات السنية الشائعة فورًا."}
          </p>
          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={handleSeedDefaults}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 shadow-xs hover:bg-slate-50"
            >
              بذر الدليل القياسي
            </button>
            <button
              onClick={openCreateModal}
              className="rounded-xl bg-brand-orange px-4 py-2 text-xs font-extrabold text-white shadow-sm hover:opacity-95"
            >
              + إضافة خدمة جديدة
            </button>
          </div>
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredServices.map((service) => {
            const catMeta = LAB_SERVICE_CATEGORY_META[service.category] || LAB_SERVICE_CATEGORY_META.prostho;
            const scopeMeta = LAB_TOOTH_SCOPE_META[service.toothScope] || LAB_TOOTH_SCOPE_META.single_tooth;

            return (
              <div
                key={service.id}
                className={`relative flex flex-col justify-between rounded-2xl border bg-white p-4 shadow-xs transition hover:shadow-md ${
                  service.isActive
                    ? "border-slate-200"
                    : "border-slate-200/80 bg-slate-50/60 opacity-80"
                }`}
              >
                {/* Header & Badges */}
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {/* Category Badge */}
                      <span
                        className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] font-bold ${catMeta.bg} ${catMeta.text} ${catMeta.border}`}
                      >
                        {catMeta.shortLabel}
                      </span>

                      {/* Code Badge */}
                      {service.code && (
                        <span className="rounded-lg bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-600">
                          {service.code}
                        </span>
                      )}
                    </div>

                    {/* Active/Inactive Toggle Switch */}
                    <button
                      type="button"
                      onClick={() => toggleServiceStatus(service)}
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-extrabold transition ${
                        service.isActive
                          ? "bg-emerald-100/80 text-emerald-800 hover:bg-emerald-200"
                          : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                      }`}
                      title={service.isActive ? "انقر لتعطيل الخدمة" : "انقر لتفعيل الخدمة"}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${
                          service.isActive ? "bg-emerald-600 animate-pulse" : "bg-slate-400"
                        }`}
                      />
                      <span>{service.isActive ? "متاحة للطلب" : "معطلة"}</span>
                    </button>
                  </div>

                  {/* Title & Description */}
                  <h4 className="mt-2.5 text-sm font-extrabold text-slate-900 leading-snug">
                    {service.name}
                  </h4>

                  {service.description && (
                    <p className="mt-1.5 text-xs text-slate-500 line-clamp-2 leading-relaxed">
                      {service.description}
                    </p>
                  )}

                  {/* Dental Chart Association Pill */}
                  <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 p-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold text-slate-500">ارتباط ملف الأسنان:</span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-black ${scopeMeta.badgeBg}`}
                      >
                        <span>{scopeMeta.icon}</span>
                        <span>{scopeMeta.label}</span>
                      </span>
                    </div>
                    <p className="mt-1 text-[10px] text-slate-400 leading-tight">
                      {scopeMeta.hint}
                    </p>
                  </div>

                  {/* Badges: Shade & Turnaround */}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] font-bold ${
                        service.requiresShade
                          ? "bg-purple-50 text-purple-700 border border-purple-200"
                          : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      <span>{service.requiresShade ? "🎨 يتطلب لون VITA" : "⚪ بدون تحديد لون"}</span>
                    </span>

                    <span className="inline-flex items-center gap-1 rounded-lg bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-800 border border-amber-200">
                      <span>⏱️ الإنجاز: {service.defaultDays || 5} أيام</span>
                    </span>

                    {(service.totalOrdersCount || 0) > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">
                        <span>📦 {service.totalOrdersCount} طلب سابق</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Card Footer Actions */}
                <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs">
                  <span className="text-[10px] text-slate-400 font-mono">
                    ترتيب العرض: {service.sortOrder}
                  </span>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEditModal(service)}
                      className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 font-bold text-brand-blue transition hover:bg-blue-50"
                    >
                      <Icon name="edit" className="h-3.5 w-3.5" />
                      <span>تعديل</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmService(service)}
                      className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 font-bold text-danger-600 transition hover:bg-danger-50"
                    >
                      <Icon name="trash" className="h-3.5 w-3.5" />
                      <span>حذف</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Table View */
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-[11px] font-extrabold text-slate-600">
                <tr>
                  <th className="p-3">الخدمة والرمز</th>
                  <th className="p-3">التصنيف</th>
                  <th className="p-3">ارتباط مخطط الأسنان</th>
                  <th className="p-3">متطلبات اللون</th>
                  <th className="p-3">مهلة التسليم</th>
                  <th className="p-3">الحالة</th>
                  <th className="p-3 text-left">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredServices.map((service) => {
                  const catMeta = LAB_SERVICE_CATEGORY_META[service.category] || LAB_SERVICE_CATEGORY_META.prostho;
                  const scopeMeta = LAB_TOOTH_SCOPE_META[service.toothScope] || LAB_TOOTH_SCOPE_META.single_tooth;

                  return (
                    <tr
                      key={service.id}
                      className={`transition hover:bg-slate-50/80 ${
                        !service.isActive ? "bg-slate-50/50 opacity-75" : ""
                      }`}
                    >
                      <td className="p-3 font-bold text-slate-900">
                        <div className="flex items-center gap-2">
                          <span>{service.name}</span>
                          {service.code && (
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
                              {service.code}
                            </span>
                          )}
                        </div>
                        {service.description && (
                          <div className="mt-0.5 text-[11px] font-normal text-slate-500 line-clamp-1">
                            {service.description}
                          </div>
                        )}
                      </td>
                      <td className="p-3">
                        <span
                          className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] font-bold ${catMeta.bg} ${catMeta.text} ${catMeta.border}`}
                        >
                          {catMeta.shortLabel}
                        </span>
                      </td>
                      <td className="p-3">
                        <span
                          className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-bold ${scopeMeta.badgeBg}`}
                        >
                          <span>{scopeMeta.icon}</span>
                          <span>{scopeMeta.shortLabel}</span>
                        </span>
                      </td>
                      <td className="p-3">
                        <span
                          className={`inline-flex rounded-md px-2 py-0.5 text-[10px] font-bold ${
                            service.requiresShade
                              ? "bg-purple-50 text-purple-700"
                              : "bg-slate-100 text-slate-500"
                          }`}
                        >
                          {service.requiresShade ? "🎨 مطلوب (VITA)" : "⚪ غير مطلوب"}
                        </span>
                      </td>
                      <td className="p-3 font-bold text-slate-700">
                        ⏱️ {service.defaultDays || 5} أيام
                      </td>
                      <td className="p-3">
                        <button
                          type="button"
                          onClick={() => toggleServiceStatus(service)}
                          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-extrabold transition ${
                            service.isActive
                              ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                              : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              service.isActive ? "bg-emerald-600" : "bg-slate-400"
                            }`}
                          />
                          <span>{service.isActive ? "نشط" : "معطل"}</span>
                        </button>
                      </td>
                      <td className="p-3 text-left">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => openEditModal(service)}
                            className="rounded-lg p-1.5 text-brand-blue hover:bg-blue-50"
                            title="تعديل"
                          >
                            <Icon name="edit" className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteConfirmService(service)}
                            className="rounded-lg p-1.5 text-danger-600 hover:bg-danger-50"
                            title="حذف"
                          >
                            <Icon name="trash" className="h-4 w-4" />
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

      {/* Add / Edit Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-xs">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-xl max-h-[92vh] overflow-y-auto rounded-3xl border border-slate-200 bg-white p-6 shadow-xl"
            dir="rtl"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <div>
                <h3 className="text-base font-black text-slate-900">
                  {editingService ? "تعديل خدمة المختبر" : "إضافة خدمة مختبر جديدة"}
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  حدد بيانات الخدمة، تصنيفها، ونوع ارتباطها بملف ومخطط الأسنان
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <Icon name="close" className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleFormSubmit} className="mt-4 space-y-4">
              {/* Service Name */}
              <div>
                <label className="block text-xs font-bold text-slate-700">
                  اسم الخدمة بالعربية والإنجليزية <span className="text-danger-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="مثال: تاج زيركون كامل (Full Zirconia Crown) أو E.max Veneer"
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-xs text-slate-900 focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue"
                />
              </div>

              {/* Code & Category Row */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-bold text-slate-700">
                    رمز الخدمة (كود فريد - اختياري)
                  </label>
                  <input
                    type="text"
                    value={formData.code}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        code: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""),
                      })
                    }
                    placeholder="مثال: CRW_ZIRC"
                    className="mt-1 w-full rounded-xl border border-slate-300 px-3.5 py-2 text-xs font-mono uppercase text-slate-900 focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700">
                    التصنيف التخصصي <span className="text-danger-500">*</span>
                  </label>
                  <select
                    value={formData.category}
                    onChange={(e) =>
                      setFormData({ ...formData, category: e.target.value as LabServiceCategory })
                    }
                    className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-bold text-slate-900 focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue"
                  >
                    {CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {LAB_SERVICE_CATEGORY_META[cat]?.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Tooth Chart Association (Interactive Cards) */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  نوع الارتباط بمخطط وملف الأسنان (Dental Chart Association){" "}
                  <span className="text-danger-500">*</span>
                </label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {TOOTH_SCOPES.map((scope) => {
                    const meta = LAB_TOOTH_SCOPE_META[scope];
                    const isSelected = formData.toothScope === scope;
                    return (
                      <button
                        key={scope}
                        type="button"
                        onClick={() => setFormData({ ...formData, toothScope: scope })}
                        className={`flex flex-col items-start rounded-xl border p-2.5 text-right transition ${
                          isSelected
                            ? "border-brand-blue bg-blue-50/50 ring-2 ring-brand-blue/30"
                            : "border-slate-200 bg-white hover:bg-slate-50"
                        }`}
                      >
                        <div className="flex items-center gap-1.5 font-bold text-xs text-slate-900">
                          <span>{meta.icon}</span>
                          <span>{meta.label}</span>
                        </div>
                        <p className="mt-1 text-[11px] text-slate-500 leading-tight">
                          {meta.hint}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Shade & Default Turnaround Row */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {/* Require Shade Toggle */}
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-bold text-slate-900">اختيار لون السن (Shade)</div>
                      <div className="text-[10px] text-slate-500">
                        يتطلب تحديد درجة VITA Classical / 3D Master
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      id="requiresShadeToggle"
                      checked={formData.requiresShade}
                      onChange={(e) =>
                        setFormData({ ...formData, requiresShade: e.target.checked })
                      }
                      className="h-5 w-5 rounded border-slate-300 text-brand-blue focus:ring-brand-blue"
                    />
                  </div>
                </div>

                {/* Turnaround Days */}
                <div>
                  <label className="block text-xs font-bold text-slate-700">
                    مدة التسليم الافتراضية (أيام)
                  </label>
                  <div className="mt-1 flex items-center gap-1.5">
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={formData.defaultDays}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          defaultDays: Math.max(1, parseInt(e.target.value) || 5),
                        })
                      }
                      className="w-20 rounded-xl border border-slate-300 px-3 py-2 text-center text-xs font-bold text-slate-900 focus:border-brand-blue focus:outline-none"
                    />
                    <div className="flex flex-wrap items-center gap-1">
                      {DELIVERY_PRESETS.map((days) => (
                        <button
                          key={days}
                          type="button"
                          onClick={() => setFormData({ ...formData, defaultDays: days })}
                          className={`rounded-lg px-2 py-1 text-[10px] font-bold transition ${
                            formData.defaultDays === days
                              ? "bg-brand-blue text-white"
                              : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                          }`}
                        >
                          {days} أيام
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Description & Technician Instructions */}
              <div>
                <label className="block text-xs font-bold text-slate-700">
                  وصف الخدمة وتعليمات التحضير للمعمل (اختياري)
                </label>
                <textarea
                  rows={2}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="ملاحظات فنية، سماكة التحضير المطلوبة، نوع الطبعة المفضلة..."
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3.5 py-2 text-xs text-slate-900 focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue"
                />
              </div>

              {/* Sort Order & Active Switch */}
              <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                <div className="flex items-center gap-2">
                  <label className="text-xs font-bold text-slate-700">ترتيب العرض:</label>
                  <input
                    type="number"
                    value={formData.sortOrder}
                    onChange={(e) =>
                      setFormData({ ...formData, sortOrder: parseInt(e.target.value) || 100 })
                    }
                    className="w-16 rounded-xl border border-slate-300 px-2 py-1 text-center text-xs font-bold text-slate-900"
                  />
                </div>

                <label className="inline-flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={formData.isActive}
                    onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                    className="h-4 w-4 rounded border-slate-300 text-brand-blue focus:ring-brand-blue"
                  />
                  <span className="text-xs font-bold text-slate-800">
                    الخدمة نشطة ومتاحة للطلب الفوري
                  </span>
                </label>
              </div>

              {/* Form Buttons */}
              <div className="mt-6 flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  disabled={busy}
                  className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded-xl bg-brand-orange px-5 py-2.5 text-xs font-extrabold text-white shadow-sm transition hover:opacity-95 disabled:opacity-50"
                >
                  {busy ? <Icon name="refresh" className="h-4 w-4 animate-spin" /> : null}
                  <span>{editingService ? "حفظ التعديلات" : "إضافة الخدمة للدليل"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete / Deactivate Confirmation Dialog */}
      {deleteConfirmService && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-xs">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-xl"
            dir="rtl"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-50 text-danger-600">
                <Icon name="trash" className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-base font-black text-slate-900">تأكيد حذف أو تعطيل الخدمة</h3>
                <p className="text-xs text-slate-500">حذف الخدمة من دليل المعمل</p>
              </div>
            </div>

            <p className="mt-4 text-xs text-slate-600 leading-relaxed">
              هل أنت متأكد من رغبتك في حذف خدمة{" "}
              <strong className="text-slate-900 font-bold">"{deleteConfirmService.name}"</strong>؟
            </p>

            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-800">
              💡 <strong>ملاحظة أمان:</strong> إذا كانت الخدمة مستخدمة في طلبات معمل أو قواعد تسعير
              سابقة، فسيتم <strong>تعطيلها بأمان</strong> وحجبها عن شاشات الطلب الجديدة لمنع تلف
              السجلات التاريخية والفواتير.
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirmService(null)}
                disabled={busy}
                className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
              >
                تراجع
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-xl bg-danger-600 px-4 py-2 text-xs font-extrabold text-white shadow-sm transition hover:bg-danger-700 disabled:opacity-50"
              >
                {busy ? <Icon name="refresh" className="h-4 w-4 animate-spin" /> : null}
                <span>تأكيد الحذف / التعطيل</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
