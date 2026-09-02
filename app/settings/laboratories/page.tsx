"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { type Currency, CURRENCIES } from "@/lib/money";

interface Laboratory {
  id: number;
  name: string;
  phone: string | null;
  whatsapp: string | null;
  address: string | null;
  contactPerson: string | null;
  currency: Currency;
  deliveryDays: number;
  note: string | null;
  isActive: boolean;
  createdAt: string;
  activeOrdersCount: number;
  totalOrdersCount: number;
}

const CURRENCY_LABELS: Record<Currency, string> = {
  YER: "ريال يمني (YER)",
  SAR: "ريال سعودي (SAR)",
  USD: "دولار أمريكي (USD)",
};

const DELIVERY_PRESETS = [3, 5, 7, 10, 14];

export default function LaboratoriesSettingsPage() {
  const [laboratories, setLaboratories] = useState<Laboratory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Search & Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [currencyFilter, setCurrencyFilter] = useState<string>("all");

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingLab, setEditingLab] = useState<Laboratory | null>(null);
  const [deleteConfirmLab, setDeleteConfirmLab] = useState<Laboratory | null>(null);

  // Form State
  const [formData, setFormData] = useState<{
    name: string;
    phone: string;
    whatsapp: string;
    address: string;
    contactPerson: string;
    currency: Currency;
    deliveryDays: number;
    note: string;
    isActive: boolean;
  }>({
    name: "",
    phone: "",
    whatsapp: "",
    address: "",
    contactPerson: "",
    currency: "YER",
    deliveryDays: 7,
    note: "",
    isActive: true,
  });

  const loadLaboratories = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/laboratories");
      if (!res.ok) {
        if (res.status === 401) {
          window.location.assign("/login");
          return;
        }
        const err = await res.json().catch(() => null);
        throw new Error(err?.message || "تعذّر تحميل قائمة المختبرات.");
      }
      const data = await res.json();
      setLaboratories(data.laboratories || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ غير متوقع.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLaboratories();
  }, [loadLaboratories]);

  const openCreateModal = () => {
    setEditingLab(null);
    setFormData({
      name: "",
      phone: "",
      whatsapp: "",
      address: "",
      contactPerson: "",
      currency: "YER",
      deliveryDays: 7,
      note: "",
      isActive: true,
    });
    setIsModalOpen(true);
  };

  const openEditModal = (lab: Laboratory) => {
    setEditingLab(lab);
    setFormData({
      name: lab.name,
      phone: lab.phone || "",
      whatsapp: lab.whatsapp || "",
      address: lab.address || "",
      contactPerson: lab.contactPerson || "",
      currency: lab.currency || "YER",
      deliveryDays: lab.deliveryDays || 7,
      note: lab.note || "",
      isActive: lab.isActive,
    });
    setIsModalOpen(true);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      setError("يرجى إدخال اسم المختبر.");
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);

    try {
      const url = editingLab
        ? `/api/laboratories/${editingLab.id}`
        : "/api/laboratories";
      const method = editingLab ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name.trim(),
          phone: formData.phone.trim() || null,
          whatsapp: formData.whatsapp.trim() || null,
          address: formData.address.trim() || null,
          contactPerson: formData.contactPerson.trim() || null,
          currency: formData.currency,
          deliveryDays: Number(formData.deliveryDays) || 7,
          note: formData.note.trim() || null,
          isActive: formData.isActive,
        }),
      });

      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.message || "تعذّر حفظ بيانات المختبر.");
      }

      setSuccess(
        editingLab
          ? `تم تحديث بيانات المختبر "${formData.name}" بنجاح.`
          : `تمت إضافة المختبر "${formData.name}" بنجاح.`
      );
      setIsModalOpen(false);
      await loadLaboratories();
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ أثناء الحفظ.");
    } finally {
      setBusy(false);
    }
  };

  const toggleLabStatus = async (lab: Laboratory) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/laboratories/${lab.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !lab.isActive }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.message || "تعذّر تحديث الحالة.");
      }
      setSuccess(`تم ${!lab.isActive ? "تفعيل" : "تعطيل"} المختبر بنجاح.`);
      await loadLaboratories();
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر تعديل حالة المختبر.");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirmLab) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/laboratories/${deleteConfirmLab.id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.message || "تعذّر حذف المختبر.");
      }
      setSuccess(data.message || "تمت العملية بنجاح.");
      setDeleteConfirmLab(null);
      await loadLaboratories();
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر إتمام الحذف.");
    } finally {
      setBusy(false);
    }
  };

  // Filtered & Sorted Labs
  const filteredLabs = useMemo(() => {
    return laboratories.filter((lab) => {
      if (statusFilter === "active" && !lab.isActive) return false;
      if (statusFilter === "inactive" && lab.isActive) return false;
      if (currencyFilter !== "all" && lab.currency !== currencyFilter) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchesName = lab.name.toLowerCase().includes(q);
        const matchesContact = (lab.contactPerson || "").toLowerCase().includes(q);
        const matchesPhone = (lab.phone || "").includes(q);
        const matchesWhatsapp = (lab.whatsapp || "").includes(q);
        const matchesAddress = (lab.address || "").toLowerCase().includes(q);
        const matchesNote = (lab.note || "").toLowerCase().includes(q);
        if (!matchesName && !matchesContact && !matchesPhone && !matchesWhatsapp && !matchesAddress && !matchesNote) {
          return false;
        }
      }
      return true;
    });
  }, [laboratories, searchQuery, statusFilter, currencyFilter]);

  // Statistics
  const stats = useMemo(() => {
    const total = laboratories.length;
    const active = laboratories.filter((l) => l.isActive).length;
    const avgDelivery = total > 0
      ? Math.round(laboratories.reduce((acc, l) => acc + (l.deliveryDays || 7), 0) / total)
      : 0;
    const totalActiveOrders = laboratories.reduce((acc, l) => acc + (l.activeOrdersCount || 0), 0);
    return { total, active, avgDelivery, totalActiveOrders };
  }, [laboratories]);

  return (
    <main className="mx-auto max-w-5xl p-4 pb-24 text-slate-800" dir="rtl">
      <PageHeader
        title="إدارة المختبرات"
        subtitle="تهيئة بيانات مختبرات صناعة التركيبات، جهات الاتصال، العملات المعتمدة، ومواعيد التسليم الافتراضية"
        links={[
          { href: "/settings", label: "عام" },
          { href: "/settings/laboratories", label: "المختبرات", current: true },
          { href: "/settings/lab-services", label: "دليل خدمات المختبر" },
          { href: "/settings/lab-pricing", label: "جدول التسعير" },
          { href: "/settings/users", label: "المستخدمون والصلاحيات" },
          { href: "/settings/audit", label: "سجل التدقيق" },
          { href: "/settings/export", label: "النسخ والتصدير" },
          { href: "/settings/ai", label: "الذكاء الاصطناعي" },
        ]}
      >
        <button
          onClick={openCreateModal}
          className="inline-flex items-center gap-2 rounded-xl bg-brand-orange px-4 py-2.5 text-xs font-extrabold text-white shadow-sm transition hover:opacity-95"
        >
          <Icon name="plus" className="h-4 w-4" />
          <span>إضافة مختبر جديد</span>
        </button>
      </PageHeader>

      {/* Navigation Sub-Tabs between Laboratories, Catalog, and Pricing */}
      <div className="mb-6 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50/80 p-1.5 shadow-xs">
        <Link
          href="/settings/laboratories"
          className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-white py-2.5 text-xs font-extrabold text-brand-blue shadow-xs"
        >
          <Icon name="briefcase" className="h-4 w-4 text-brand-orange" />
          <span>المختبرات والمعامل الخارجية</span>
          <span className="rounded-full bg-brand-blue/10 px-2 py-0.5 text-[10px] font-black text-brand-blue">
            {laboratories.length}
          </span>
        </Link>
        <Link
          href="/settings/lab-services"
          className="flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-xs font-bold text-slate-600 transition hover:bg-white hover:text-slate-900"
        >
          <Icon name="tag" className="h-4 w-4 text-slate-500" />
          <span>دليل خدمات المختبر (Catalog)</span>
        </Link>
        <Link
          href="/settings/lab-pricing"
          className="flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-xs font-bold text-slate-600 transition hover:bg-white hover:text-emerald-700"
        >
          <span className="text-sm">🏷️</span>
          <span>جدول التسعير المركزي</span>
        </Link>
        <Link
          href="/finance/lab-accounting"
          className="flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-xs font-bold text-indigo-700 bg-indigo-50/50 transition hover:bg-white hover:text-indigo-900 border border-indigo-200/60"
        >
          <span className="text-sm">📚</span>
          <span>ربط بنود الحسابات وقائمة الدخل</span>
        </Link>
        <Link
          href="/finance/parties"
          className="flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-xs font-bold text-slate-600 transition hover:bg-white hover:text-amber-800"
        >
          <span className="text-sm">🏛️</span>
          <span>دفتر حسابات الجهات والالتزامات</span>
        </Link>
      </div>

      {/* Financial Ledger Integration Notice */}
      <div className="mb-5 rounded-2xl border border-blue-200/80 bg-blue-50/50 p-4 text-xs text-navy-950">
        <div className="flex items-start gap-3">
          <span className="text-lg">⚖️</span>
          <div>
            <h4 className="font-extrabold text-navy-900">ربط مالي مباشر مع دفتر الأستاذ (General Ledger & Payables)</h4>
            <p className="mt-0.5 text-slate-600 leading-relaxed">
              كل مختبر في هذا الدليل يُسجَّل كـ <strong>طرف مالي معتمد (Party ID)</strong> في قاعدة البيانات تلقائياً. عند إصدار أو استلام أي تركيبة سنية بتكلفة، يتم قيد <strong>استحقاق مالي (Payable)</strong> على حساب المختبر فوراً، وعند السداد يُسجل سند الصرف لخصم رصيد الالتزام وتوثيق حركة الدفتر بدقة تامة.
            </p>
          </div>
        </div>
      </div>

      {/* Alert Banners */}
      {error && (
        <div role="alert" className="mb-4 flex items-center justify-between gap-2 rounded-xl border border-danger-300 bg-danger-50 px-4 py-3 text-sm font-bold text-danger-800">
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
        <div role="status" className="mb-4 flex items-center justify-between gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800">
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
      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="إحصائيات سريعة">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <span className="block text-[11px] font-bold text-slate-500">إجمالي المختبرات</span>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-black text-navy-900">{stats.total}</span>
            <span className="text-xs font-semibold text-slate-400">مختبر مسجل</span>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <span className="block text-[11px] font-bold text-slate-500">المختبرات النشطة</span>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-black text-emerald-700">{stats.active}</span>
            <span className="text-xs font-semibold text-slate-400">جاهزة للطلب</span>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <span className="block text-[11px] font-bold text-slate-500">متوسط مدة التسليم</span>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-black text-brand-blue">{stats.avgDelivery}</span>
            <span className="text-xs font-semibold text-slate-400">أيام عمل</span>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <span className="block text-[11px] font-bold text-slate-500">طلبات قيد الإنجاز</span>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-black text-amber-600">{stats.totalActiveOrders}</span>
            <span className="text-xs font-semibold text-slate-400">عمل مفتوح</span>
          </div>
        </div>
      </section>

      {/* Controls & Search Bar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Icon name="search" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            placeholder="ابحث بالاسم، المسؤول، الهاتف، الواتساب، أو العنوان..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pe-4 ps-10 text-sm placeholder:text-slate-400 focus:border-navy-500 focus:outline-none focus:ring-1 focus:ring-navy-500"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Status Filter */}
          <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1">
            <button
              onClick={() => setStatusFilter("all")}
              className={`rounded-lg px-3 py-1 text-xs font-bold transition ${
                statusFilter === "all" ? "bg-navy-900 text-white" : "text-slate-600 hover:text-navy-900"
              }`}
            >
              الكل ({laboratories.length})
            </button>
            <button
              onClick={() => setStatusFilter("active")}
              className={`rounded-lg px-3 py-1 text-xs font-bold transition ${
                statusFilter === "active" ? "bg-navy-900 text-white" : "text-slate-600 hover:text-navy-900"
              }`}
            >
              نشط ({stats.active})
            </button>
            <button
              onClick={() => setStatusFilter("inactive")}
              className={`rounded-lg px-3 py-1 text-xs font-bold transition ${
                statusFilter === "inactive" ? "bg-navy-900 text-white" : "text-slate-600 hover:text-navy-900"
              }`}
            >
              معطل ({stats.total - stats.active})
            </button>
          </div>

          {/* Currency Filter */}
          <select
            value={currencyFilter}
            onChange={(e) => setCurrencyFilter(e.target.value)}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 focus:border-navy-500 focus:outline-none"
          >
            <option value="all">كل العملات</option>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Laboratories List / Grid */}
      {loading ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-3 border-brand-orange border-t-transparent"></div>
          <span className="mt-3 text-xs font-bold text-slate-500">جاري تحميل بيانات المختبرات...</span>
        </div>
      ) : filteredLabs.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
            <Icon name="flask" className="h-6 w-6" />
          </div>
          <h2 className="mt-3 text-sm font-bold text-navy-900">
            {searchQuery || statusFilter !== "all" || currencyFilter !== "all"
              ? "لا توجد نتائج مطابقة لبحثك"
              : "لا توجد مختبرات مضافة حتى الآن"}
          </h2>
          <p className="mt-1 max-w-sm text-xs text-slate-500">
            {searchQuery || statusFilter !== "all" || currencyFilter !== "all"
              ? "جرّب تغيير عبارة البحث أو إعادة ضبط خيارات التصفية."
              : "أضف مختبرات الأسنان التي تتعامل معها العيادة لتوثيق أعمال التركيبات ومتابعة مواعيد تسليمها تلقائيًا."}
          </p>
          {!searchQuery && statusFilter === "all" && currencyFilter === "all" && (
            <button
              onClick={openCreateModal}
              className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-brand-orange px-4 py-2 text-xs font-extrabold text-white transition hover:opacity-95"
            >
              <Icon name="plus" className="h-4 w-4" />
              <span>إضافة أول مختبر</span>
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {filteredLabs.map((lab) => (
            <div
              key={lab.id}
              className={`flex flex-col justify-between rounded-2xl border bg-white p-5 shadow-xs transition hover:shadow-md ${
                lab.isActive ? "border-slate-200" : "border-slate-200 bg-slate-50/70 opacity-80"
              }`}
            >
              <div>
                {/* Card Top: Title & Status */}
                <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-navy-50 text-navy-800">
                      <Icon name="flask" className="h-5 w-5 text-brand-orange" />
                    </div>
                    <div>
                      <h3 className="text-base font-extrabold text-navy-900">{lab.name}</h3>
                      {lab.contactPerson && (
                        <p className="flex items-center gap-1 text-xs font-medium text-slate-500">
                          <Icon name="user" className="h-3 w-3 text-slate-400" />
                          <span>المسؤول: {lab.contactPerson}</span>
                        </p>
                      )}
                    </div>
                  </div>

                    <div className="flex items-center gap-1.5">
                      <span
                        className="inline-flex items-center rounded-md bg-navy-50 px-2 py-0.5 text-[10px] font-mono font-bold text-navy-800 border border-navy-200/60"
                        title="معرّف الجهة المالي (Party ID) المسجل في جدول الأطراف ودفتر الأستاذ"
                      >
                        Party #{lab.id}
                      </span>
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
                          lab.isActive
                            ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20"
                            : "bg-slate-100 text-slate-600 ring-1 ring-slate-400/20"
                        }`}
                      >
                        {lab.isActive ? "نشط" : "معطل"}
                      </span>
                    </div>
                </div>

                {/* Card Body: Details Grid */}
                <div className="mt-3.5 space-y-2 text-xs">
                  {/* Currency & Delivery Time */}
                  <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-2.5">
                    <div>
                      <span className="block text-[10px] font-bold text-slate-400">عملة التعامل</span>
                      <span className="font-extrabold text-navy-900">{CURRENCY_LABELS[lab.currency] || lab.currency}</span>
                    </div>
                    <div>
                      <span className="block text-[10px] font-bold text-slate-400">مدة التسليم الافتراضية</span>
                      <span className="flex items-center gap-1 font-extrabold text-brand-blue">
                        <Icon name="clock" className="h-3.5 w-3.5" />
                        {lab.deliveryDays} أيام عمل
                      </span>
                    </div>
                  </div>

                  {/* Phone & WhatsApp */}
                  <div className="flex flex-wrap items-center gap-3 pt-1 text-slate-600">
                    {lab.phone && (
                      <div className="flex items-center gap-1.5 font-mono text-[13px] font-semibold" dir="ltr">
                        <Icon name="phone" className="h-3.5 w-3.5 text-slate-400" />
                        <span>{lab.phone}</span>
                      </div>
                    )}
                    {lab.whatsapp && (
                      <div className="flex items-center gap-1.5 font-mono text-[13px] font-semibold text-emerald-700" dir="ltr">
                        <Icon name="chat" className="h-3.5 w-3.5 text-emerald-600" />
                        <span>{lab.whatsapp}</span>
                      </div>
                    )}
                  </div>

                  {/* Address */}
                  {lab.address && (
                    <p className="flex items-center gap-1.5 text-slate-600">
                      <span className="font-bold text-slate-400">العنوان:</span>
                      <span className="truncate">{lab.address}</span>
                    </p>
                  )}

                  {/* Note */}
                  {lab.note && (
                    <p className="rounded-lg bg-amber-50/60 p-2 text-[11px] text-amber-900 border border-amber-100">
                      <span className="font-bold">ملاحظة:</span> {lab.note}
                    </p>
                  )}
                </div>
              </div>

              {/* Card Footer: Action Bar */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
                <div className="flex items-center gap-1.5">
                  {lab.whatsapp && (
                    <a
                      href={`https://wa.me/${lab.whatsapp.replace(/[^0-9]/g, "")}?text=${encodeURIComponent(
                        `مرحباً ${lab.name}، نود الاستفسار بخصوص أعمال التركيبات.`
                      )}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-bold text-emerald-700 hover:bg-emerald-100"
                      title="محادثة واتساب مباشرة"
                    >
                      <Icon name="chat" className="h-3.5 w-3.5 text-emerald-600" />
                      <span>واتساب</span>
                    </a>
                  )}

                  {lab.phone && (
                    <a
                      href={`tel:${lab.phone}`}
                      className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-200"
                      title="اتصال هاتفي"
                    >
                      <Icon name="phone" className="h-3.5 w-3.5 text-slate-500" />
                      <span>اتصال</span>
                    </a>
                  )}

                  <a
                    href={`/settings/lab-pricing`}
                    className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-bold text-emerald-800 hover:bg-emerald-100"
                    title="جدول أسعار هذا المختبر"
                  >
                    <span>🏷️ الأسعار</span>
                  </a>

                  <a
                    href={`/finance/parties/${lab.id}`}
                    className="inline-flex items-center gap-1 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs font-bold text-amber-900 hover:bg-amber-100 border border-amber-200/60"
                    title="كشف حساب المعمل المالي في دفتر الأستاذ (الاستحقاقات والمدفوعات)"
                  >
                    <span>💳 كشف الحساب</span>
                  </a>

                  <a
                    href={`/lab`}
                    className="inline-flex items-center gap-1 rounded-lg bg-navy-50 px-2.5 py-1.5 text-xs font-bold text-navy-800 hover:bg-navy-100"
                    title="سجل طلبات المختبر"
                  >
                    <span>الطلبات ({lab.activeOrdersCount})</span>
                  </a>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => toggleLabStatus(lab)}
                    disabled={busy}
                    className={`rounded-lg px-2.5 py-1.5 text-xs font-bold transition ${
                      lab.isActive
                        ? "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                        : "text-emerald-700 hover:bg-emerald-50"
                    }`}
                  >
                    {lab.isActive ? "تعطيل" : "تفعيل"}
                  </button>

                  <button
                    onClick={() => openEditModal(lab)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800 transition hover:bg-slate-50"
                  >
                    <Icon name="edit" className="h-3.5 w-3.5 text-slate-400" />
                    <span>تعديل</span>
                  </button>

                  <button
                    onClick={() => setDeleteConfirmLab(lab)}
                    className="rounded-lg p-1.5 text-slate-400 transition hover:bg-danger-50 hover:text-danger-600"
                    title="حذف المختبر"
                  >
                    <Icon name="trash" className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / Edit Laboratory Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/60 p-4 backdrop-blur-xs">
          <div className="relative w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
            {/* Modal Header */}
            <div className="flex items-start justify-between border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-lg font-black text-navy-900">
                  {editingLab ? `تعديل بيانات المختبر (Party #${editingLab.id})` : "إضافة مختبر جديد"}
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  {editingLab
                    ? "يتم تحديث بيانات المعمل وربطها التلقائي بسجلات الذمم والدفعات المالية"
                    : "سيتم إنشاء معرّف مالي (Party ID) تلقائياً لربط استحقاقات ومدفوعات المعمل بدفتر الأستاذ"}
                </p>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <Icon name="close" className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Form */}
            <form onSubmit={handleFormSubmit} className="mt-4 space-y-4">
              {/* Name (الاسم) */}
              <div>
                <label className="mb-1 block text-xs font-bold text-navy-900">
                  اسم المختبر <span className="text-danger-600">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="مثال: مختبر السعادة لصناعة الأسنان والتركيبات"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm focus:border-navy-600 focus:outline-none focus:ring-1 focus:ring-navy-600"
                />
              </div>

              {/* Contact Person (المسؤول) */}
              <div>
                <label className="mb-1 block text-xs font-bold text-navy-900">
                  الشخص المسؤول / فني الاستلام
                </label>
                <input
                  type="text"
                  placeholder="مثال: د. سامي المروني / فني أول"
                  value={formData.contactPerson}
                  onChange={(e) => setFormData({ ...formData, contactPerson: e.target.value })}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm focus:border-navy-600 focus:outline-none focus:ring-1 focus:ring-navy-600"
                />
              </div>

              {/* Phone & WhatsApp (الهاتف والواتساب) */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-bold text-navy-900">
                    رقم الهاتف
                  </label>
                  <input
                    type="tel"
                    placeholder="777000000"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm text-left focus:border-navy-600 focus:outline-none focus:ring-1 focus:ring-navy-600"
                    dir="ltr"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs font-bold text-navy-900">
                    رقم الواتساب
                  </label>
                  <input
                    type="tel"
                    placeholder="967777000000"
                    value={formData.whatsapp}
                    onChange={(e) => setFormData({ ...formData, whatsapp: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm text-left focus:border-navy-600 focus:outline-none focus:ring-1 focus:ring-navy-600"
                    dir="ltr"
                  />
                </div>
              </div>

              {/* Currency & Delivery Duration (العملة ومدة التسليم) */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-bold text-navy-900">
                    العملة المعتمدة
                  </label>
                  <select
                    value={formData.currency}
                    onChange={(e) => setFormData({ ...formData, currency: e.target.value as Currency })}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm focus:border-navy-600 focus:outline-none focus:ring-1 focus:ring-navy-600"
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c}>
                        {CURRENCY_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-bold text-navy-900">
                    مدة التسليم الافتراضية (بالأيام)
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={1}
                      max={365}
                      required
                      value={formData.deliveryDays}
                      onChange={(e) => setFormData({ ...formData, deliveryDays: Number(e.target.value) || 1 })}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm focus:border-navy-600 focus:outline-none focus:ring-1 focus:ring-navy-600"
                    />
                    <span className="shrink-0 text-xs font-bold text-slate-500">أيام</span>
                  </div>
                </div>
              </div>

              {/* Quick Delivery Presets */}
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-bold text-slate-400">خيارات سريعة:</span>
                {DELIVERY_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setFormData({ ...formData, deliveryDays: preset })}
                    className={`rounded-lg px-2 py-0.5 text-[11px] font-bold transition ${
                      formData.deliveryDays === preset
                        ? "bg-navy-900 text-white"
                        : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {preset} أيام
                  </button>
                ))}
              </div>

              {/* Address (العنوان) */}
              <div>
                <label className="mb-1 block text-xs font-bold text-navy-900">
                  العنوان الجغرافي للمختبر
                </label>
                <input
                  type="text"
                  placeholder="مثال: صنعاء - شارع حدة - عمارة الشروق الدور الثالث"
                  value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm focus:border-navy-600 focus:outline-none focus:ring-1 focus:ring-navy-600"
                />
              </div>

              {/* Note (ملاحظات) */}
              <div>
                <label className="mb-1 block text-xs font-bold text-navy-900">
                  ملاحظات إضافية (الخصومات، شروط التعامل، نوع التركيبات المتميزة...)
                </label>
                <textarea
                  rows={2}
                  placeholder="أي تفاصيل خاصة بالدفع أو ضمان التركيبات..."
                  value={formData.note}
                  onChange={(e) => setFormData({ ...formData, note: e.target.value })}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm focus:border-navy-600 focus:outline-none focus:ring-1 focus:ring-navy-600"
                />
              </div>

              {/* Status (الحالة: نشط / معطل) */}
              <div className="flex items-center gap-2 rounded-xl bg-slate-50 p-3">
                <input
                  type="checkbox"
                  id="lab-is-active"
                  checked={formData.isActive}
                  onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-navy-900 focus:ring-navy-600"
                />
                <label htmlFor="lab-is-active" className="text-xs font-bold text-navy-900 cursor-pointer">
                  المختبر نشط ومتاح للاختيار عند إنشاء طلبات جديدة
                </label>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  disabled={busy}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded-xl bg-navy-900 px-5 py-2 text-xs font-extrabold text-white shadow-sm transition hover:bg-navy-800 disabled:opacity-50"
                >
                  {busy ? (
                    <span>جاري الحفظ...</span>
                  ) : (
                    <>
                      <Icon name="check" className="h-4 w-4" />
                      <span>{editingLab ? "حفظ التعديلات" : "إضافة المختبر"}</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmLab && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-50 text-danger-600">
              <Icon name="trash" className="h-6 w-6" />
            </div>
            <h3 className="mt-4 text-base font-black text-navy-900">
              حذف المختبر «{deleteConfirmLab.name}»
            </h3>
            <p className="mt-1 text-xs text-slate-500 leading-relaxed">
              إذا كانت هناك طلبات سابقة مرتبطة بهذا المختبر، فسيتم تعطيله تلقائياً للحفاظ على سلامة القيود المالية وسجل الطلبات.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirmLab(null)}
                disabled={busy}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
              >
                تراجع
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={busy}
                className="rounded-xl bg-danger-600 px-4 py-2 text-xs font-extrabold text-white shadow-sm transition hover:bg-danger-700"
              >
                {busy ? "جاري المعالجة..." : "تأكيد الحذف / التعطيل"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
