"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { clinicDateString } from "@/lib/schedule";
import {
  HR_CONTRACT_KIND_LABELS,
  HR_CONTRACT_STATUS_LABELS,
  type HrContractKind,
  type HrContractStatus,
} from "@/lib/hr-contracts-attendance-shared";
import { CURRENCIES, CURRENCY_SHORT, formatAmount, parseAmount, toInputAmount, type Currency } from "@/lib/money";

interface ContractItem {
  id: string;
  staffId: string;
  staffName?: string;
  jobTitle?: string;
  contractNumber: string;
  title: string;
  templateKind: HrContractKind;
  status: HrContractStatus;
  startDate: string;
  endDate: string | null;
  probationEndDate: string | null;
  baseSalaryMinor: number;
  salaryCurrency: Currency;
  commissionRatePercent: number;
  hourlyRate: number;
  workingHoursPerWeek: number;
  termsPayload: { clauses?: string[] };
  approvedBy: string | null;
  approvedAt: string | null;
  addendaCount?: number;
  createdAt: string;
}

interface StaffOption {
  id: number;
  fullName: string;
  jobTitle: string;
  department: string;
}

interface AddendumItem {
  id: string;
  contractId: string;
  addendumNumber: string;
  title: string;
  startDate: string;
  addendumReason: string;
  contractNumber: string;
  termsPayload: { clauses?: string[] };
  createdAt: string;
}

export function HrContractsPanel() {
  const [contracts, setContracts] = useState<ContractItem[]>([]);
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [kindFilter, setKindFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modals state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [selectedContract, setSelectedContract] = useState<ContractItem | null>(null);
  const [contractDetails, setContractDetails] = useState<{ contract: ContractItem; addenda: AddendumItem[] } | null>(null);
  const [addendumModalOpen, setAddendumModalOpen] = useState(false);
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [targetStatus, setTargetStatus] = useState<HrContractStatus>("approved");
  const [statusReason, setStatusReason] = useState("");

  // Create form state
  const [formStaffId, setFormStaffId] = useState("");
  const [formTitle, setFormTitle] = useState("");
  const [formKind, setFormKind] = useState<HrContractKind>("fixed_salary");
  const [formStartDate, setFormStartDate] = useState(() => clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));
  const [formEndDate, setFormEndDate] = useState("");
  const [formProbationDate, setFormProbationDate] = useState("");
  const [formCurrency, setFormCurrency] = useState("YER");
  const [doctorParties,setDoctorParties] = useState<Array<{id:number;name:string;commissionPercent:number}>>([]);
  const [formDoctorPartyId,setFormDoctorPartyId] = useState("");
  const [addendumSalary,setAddendumSalary] = useState("");
  const [addendumCurrency,setAddendumCurrency] = useState<Currency>("YER");
  useEffect(()=>{ void fetch("/api/parties?kind=doctor").then(async(r)=>{if(r.ok) setDoctorParties(await r.json());}).catch(()=>{}); },[]);
  const [formBaseSalary, setFormBaseSalary] = useState("0");
  const [formCommissionRate, setFormCommissionRate] = useState("0");
  const [formHourlyRate, setFormHourlyRate] = useState("0");
  const [formHoursWeek, setFormHoursWeek] = useState("48");
  const [formClauses, setFormClauses] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Addendum form state
  const [addendumTitle, setAddendumTitle] = useState("");
  const [addendumEffectiveDate, setAddendumEffectiveDate] = useState(() => clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));
  const [addendumContent, setAddendumContent] = useState("");

  const loadContracts = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (kindFilter) params.set("contractKind", kindFilter);
      const res = await fetch(`/api/hr/contracts?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error("تعذّر تحميل العقود.");
      const data = await res.json();
      setContracts(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message || "حدث خطأ أثناء تحميل العقود.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, kindFilter]);

  const loadStaff = useCallback(async () => {
    try {
      const res = await fetch("/api/hr/staff", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setStaffOptions(data);
      }
    } catch {
      // Ignored
    }
  }, []);

  useEffect(() => {
    void loadContracts();
    void loadStaff();
  }, [loadContracts, loadStaff]);

  const openDetails = async (contract: ContractItem) => {
    setSelectedContract(contract);
    try {
      const res = await fetch(`/api/hr/contracts/${contract.id}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setContractDetails(data);
      }
    } catch {
      // Ignored
    }
  };

  const applyTemplate = (template: "fixed" | "doctor_pct" | "hybrid" | "probation") => {
    if (template === "fixed") {
      setFormKind("fixed_salary");
      setFormTitle("عقد عمل محدد المدة");
      setFormBaseSalary("150000");
      setFormCommissionRate("0");
      setFormClauses("1. يلتزم الطرف الثاني بأداء مهام وظيفته وفقاً لتعليمات الإدارة واللوائح الداخلية.\n2. ساعات العمل 48 ساعة أسبوعياً مع راحة يوم واحد.\n3. الإجازة السنوية 30 يوماً مدفوعة الأجر بعد إكمال سنة عمل.");
    } else if (template === "doctor_pct") {
      setFormKind("percentage");
      setFormTitle("عقد طبيب بنسبة معتمدة");
      setFormBaseSalary("0");
      setFormCommissionRate("40");
      setFormClauses("1. يستحق الطبيب نسبة صافية عن الحالات المنجزة وفق سجلات النظام الآلية.\n2. يتم صرف المستحقات شهرياً بعد تدقيق ومطابقة فواتير المركز.\n3. يلتزم الطبيب بالحضور وفق جدول المواعيد المعتمد.");
    } else if (template === "hybrid") {
      setFormKind("hybrid");
      setFormTitle("عقد مختلط (راتب أساسي ونسبة)");
      setFormBaseSalary("100000");
      setFormCommissionRate("20");
      setFormClauses("1. يمنح الطرف الثاني راتباً أساسياً شهرياً بالإضافة إلى نسبة إنجاز محددة.\n2. يتم احتساب النسبة شهرياً وإضافتها لمسير الرواتب.");
    } else if (template === "probation") {
      setFormKind("probation");
      setFormTitle("عقد تدريب وتجربة");
      setFormBaseSalary("80000");
      setFormCommissionRate("0");
      const d = new Date();
      d.setMonth(d.getMonth() + 3);
      setFormProbationDate(clinicDateString(d, CLINIC_ZONE_FALLBACK));
      setFormClauses("1. فترة تجربة مدتها 3 أشهر لتقييم الكفاءة والالتزام.\n2. يحق لأي من الطرفين إنهاء العقد خلال فترة التجربة مع إشعار كتابي.");
    }
  };

  const handleCreateContract = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formStaffId || !formTitle) {
      alert("يرجى تعبئة الحقول الإلزامية.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/hr/contracts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: formStaffId,

          title: formTitle,
          templateKind: formKind,
          compensationKind: ["doctor_percentage","percentage"].includes(formKind) ? "commission" : ["doctor_hybrid","hybrid"].includes(formKind) ? "salary_commission" : "salary",
          startDate: formStartDate,
          endDate: formEndDate || null,
          probationEndDate: formProbationDate || null,
          salaryCurrency: formCurrency,
          salaryPeriod: "monthly",
          baseSalaryMinor: parseAmount(formBaseSalary, formCurrency as Currency),
          commissionRatePercent: Number(formCommissionRate),
          doctorPartyId: formDoctorPartyId ? Number(formDoctorPartyId) : null,
          hourlyRate: parseFloat(formHourlyRate) || 0,
          workingHoursPerWeek: parseInt(formHoursWeek, 10) || 48,
          termsPayload: { clauses: formClauses.split("\n").filter(Boolean), workingHoursPerWeek: Number(formHoursWeek) },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "تعذّر إنشاء العقد.");
      }
      setCreateModalOpen(false);
      void loadContracts();
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء حفظ العقد.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleTransitionStatus = async () => {
    if (!selectedContract) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/hr/contracts/${selectedContract.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "transition",
          status: targetStatus,
          reason: statusReason || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "تعذّر تغيير حالة العقد.");
      }
      setStatusModalOpen(false);
      setStatusReason("");
      void loadContracts();
      if (contractDetails) {
        void openDetails(selectedContract);
      }
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء تغيير الحالة.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddAddendum = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedContract || !addendumTitle || !addendumContent) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/hr/contracts/${selectedContract.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: addendumTitle,
          startDate: addendumEffectiveDate,
          addendumReason: addendumContent,
          ...(addendumSalary ? {baseSalaryMinor:parseAmount(addendumSalary,addendumCurrency),salaryCurrency:addendumCurrency,salaryPeriod:"monthly"} : {}),
          termsPayload: { clauses: addendumContent.split("\n").filter(Boolean) },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "تعذّر إضافة الملحق.");
      }
      setAddendumModalOpen(false);
      setAddendumTitle("");
      setAddendumContent("");
      void openDetails(selectedContract);
      void loadContracts();
    } catch (err: any) {
      alert(err.message || "حدث خطأ أثناء إضافة الملحق.");
    } finally {
      setSubmitting(false);
    }
  };

  const filteredContracts = contracts.filter((c) => {
    if (!search.trim()) return true;
    const term = search.toLowerCase();
    return (
      c.contractNumber.toLowerCase().includes(term) ||
      c.title.toLowerCase().includes(term) ||
      (c.staffName && c.staffName.toLowerCase().includes(term))
    );
  });

  const activeCount = contracts.filter((c) => c.status === "active").length;
  const draftCount = contracts.filter((c) => c.status === "draft" || c.status === "under_review").length;

  return (
    <section aria-label="إدارة العقود" className="space-y-4">
      {/* Stats bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-2xl border border-navy-100 bg-white p-4 shadow-sm">
          <div className="text-xs font-semibold text-navy-500">إجمالي العقود</div>
          <div className="mt-1 text-2xl font-bold text-navy-800">{contracts.length}</div>
        </div>
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50/50 p-4 shadow-sm">
          <div className="text-xs font-semibold text-emerald-700">العقود السارية</div>
          <div className="mt-1 text-2xl font-bold text-emerald-800">{activeCount}</div>
        </div>
        <div className="rounded-2xl border border-amber-100 bg-amber-50/50 p-4 shadow-sm">
          <div className="text-xs font-semibold text-amber-700">مسودات وقيد المراجعة</div>
          <div className="mt-1 text-2xl font-bold text-amber-800">{draftCount}</div>
        </div>
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={() => {
              setCreateModalOpen(true);
            }}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-navy-800 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-navy-700"
          >
            <span>+</span>
            <span>إنشاء عقد جديد</span>
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-navy-100 bg-white p-3 shadow-sm">
        <input
          type="search"
          placeholder="بحث برقم العقد أو اسم الموظف..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-[200px] flex-1 rounded-xl border border-navy-200 bg-navy-50/50 px-3 py-2 text-sm text-navy-800 outline-none transition focus:border-navy-500 focus:bg-white"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-xl border border-navy-200 bg-white px-3 py-2 text-sm text-navy-800 outline-none"
        >
          <option value="">جميع الحالات</option>
          {Object.entries(HR_CONTRACT_STATUS_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          className="rounded-xl border border-navy-200 bg-white px-3 py-2 text-sm text-navy-800 outline-none"
        >
          <option value="">جميع أنواع العقود</option>
          {Object.entries(HR_CONTRACT_KIND_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-12 text-center text-sm text-navy-500">جاري تحميل العقود...</div>
      ) : filteredContracts.length === 0 ? (
        <div className="rounded-2xl border border-navy-100 bg-white p-8 text-center text-navy-500">
          لا توجد عقود مسجلة تطابق البحث.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-navy-100 bg-white shadow-sm">
          <table className="w-full text-right text-sm">
            <thead className="border-b border-navy-100 bg-navy-50/60 text-xs font-semibold text-navy-600">
              <tr>
                <th className="px-4 py-3">رقم العقد</th>
                <th className="px-4 py-3">الموظف</th>
                <th className="px-4 py-3">نوع العقد</th>
                <th className="px-4 py-3">الأجر / النسبة</th>
                <th className="px-4 py-3">المدة والتواريخ</th>
                <th className="px-4 py-3">الحالة</th>
                <th className="px-4 py-3 text-center">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-100">
              {filteredContracts.map((c) => {
                const isExpiringSoon =
                  c.endDate &&
                  new Date(c.endDate).getTime() - Date.now() < 30 * 24 * 3600 * 1000 &&
                  new Date(c.endDate).getTime() > Date.now();

                return (
                  <tr key={c.id} className="transition hover:bg-navy-50/40">
                    <td className="px-4 py-3 font-semibold text-navy-900">
                      <div>{c.contractNumber}</div>
                      <div className="text-xs text-navy-500">{c.title}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-navy-800">{c.staffName || `موظف #${c.staffId}`}</div>
                      {c.jobTitle && <div className="text-xs text-navy-500">{c.jobTitle}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-block rounded-lg bg-navy-100 px-2.5 py-1 text-xs font-semibold text-navy-700">
                        {HR_CONTRACT_KIND_LABELS[c.templateKind] || c.templateKind}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {c.baseSalaryMinor > 0 && (
                        <div>
                          {formatAmount(c.baseSalaryMinor, c.salaryCurrency as Currency)}{" "}
                          {CURRENCY_SHORT[c.salaryCurrency as Currency] || c.salaryCurrency}
                        </div>
                      )}
                      {c.commissionRatePercent > 0 && (
                        <div className="text-emerald-700">نسبة: {c.commissionRatePercent}%</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <div>من: {c.startDate}</div>
                      {c.endDate ? (
                        <div className={isExpiringSoon ? "font-bold text-amber-700" : "text-navy-500"}>
                          إلى: {c.endDate} {isExpiringSoon && "(يقترب الانتهاء)"}
                        </div>
                      ) : (
                        <div className="text-navy-400">غير محدد (مستمر)</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-lg px-2.5 py-1 text-xs font-semibold ${
                          c.status === "active"
                            ? "bg-emerald-100 text-emerald-800"
                            : c.status === "approved"
                            ? "bg-blue-100 text-blue-800"
                            : c.status === "under_review"
                            ? "bg-amber-100 text-amber-800"
                            : c.status === "terminated" || c.status === "expired"
                            ? "bg-rose-100 text-rose-800"
                            : "bg-navy-100 text-navy-700"
                        }`}
                      >
                        {HR_CONTRACT_STATUS_LABELS[c.status] || c.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void openDetails(c)}
                          className="rounded-lg border border-navy-200 px-2.5 py-1 text-xs font-semibold text-navy-700 transition hover:bg-navy-100"
                        >
                          عرض وتعديل
                        </button>
                        <a
                          href={`/print/hr/contracts/${c.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-lg border border-navy-200 px-2 py-1 text-xs text-navy-600 transition hover:bg-navy-100"
                          title="طباعة العقد"
                        >
                          طباعة
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Contract Modal */}
      {createModalOpen && (
        <Modal onClose={() => setCreateModalOpen(false)}>
          <form onSubmit={handleCreateContract} className="space-y-4">
            <h3 className="text-lg font-bold text-navy-900">إنشاء عقد وظيفي جديد</h3>

            {/* Template Selector */}
            <div className="rounded-xl border border-navy-100 bg-navy-50/50 p-3">
              <div className="mb-2 text-xs font-semibold text-navy-600">اختر قالباً جاهزاً لتعبئة البنود تلقائياً:</div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => applyTemplate("fixed")}
                  className="rounded-lg border border-navy-200 bg-white px-2.5 py-1 text-xs font-medium text-navy-800 hover:bg-navy-100"
                >
                  عقد محدد (راتب)
                </button>
                <button
                  type="button"
                  onClick={() => applyTemplate("doctor_pct")}
                  className="rounded-lg border border-navy-200 bg-white px-2.5 py-1 text-xs font-medium text-navy-800 hover:bg-navy-100"
                >
                  عقد طبيب (نسبة)
                </button>
                <button
                  type="button"
                  onClick={() => applyTemplate("hybrid")}
                  className="rounded-lg border border-navy-200 bg-white px-2.5 py-1 text-xs font-medium text-navy-800 hover:bg-navy-100"
                >
                  عقد مختلط (راتب ونسبة)
                </button>
                <button
                  type="button"
                  onClick={() => applyTemplate("probation")}
                  className="rounded-lg border border-navy-200 bg-white px-2.5 py-1 text-xs font-medium text-navy-800 hover:bg-navy-100"
                >
                  فترة تجربة
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">الموظف *</label>
                <select
                  required
                  value={formStaffId}
                  onChange={(e) => setFormStaffId(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                >
                  <option value="">اختر الموظف...</option>
                  {staffOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.fullName} ({s.jobTitle || s.department})
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-xs text-navy-500">رقم العقد يُنشأ تلقائيًا عند الحفظ.</p>
            </div>

            <label className="block text-xs font-semibold">جهة الطبيب في محرك العمولات
              <select value={formDoctorPartyId} onChange={(e)=>{setFormDoctorPartyId(e.target.value);const doctor=doctorParties.find((d)=>String(d.id)===e.target.value);if(doctor)setFormCommissionRate(String(doctor.commissionPercent));}} required={["percentage","doctor_percentage","hybrid","doctor_hybrid"].includes(formKind)} className="w-full rounded-xl border p-2">
                <option value="">اختر جهة الطبيب للعقد بنسبة أو مختلط</option>{doctorParties.map((d)=><option key={d.id} value={d.id}>{d.name} ({d.commissionPercent}%)</option>)}
              </select>
            </label>
            <p className="text-xs text-navy-500">العمولة تُحتسب من محرك العمولات القائم. اختلاف نسبة العقد عن السياسة السارية يحجب اعتماد المسير.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">مسمى العقد *</label>
                <input
                  required
                  type="text"
                  value={formTitle}
                  onChange={(e) => setFormTitle(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">نوع العقد *</label>
                <select
                  value={formKind}
                  onChange={(e) => setFormKind(e.target.value as HrContractKind)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                >
                  {Object.entries(HR_CONTRACT_KIND_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">تاريخ البدء *</label>
                <input
                  required
                  type="date"
                  value={formStartDate}
                  onChange={(e) => setFormStartDate(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">تاريخ الانتهاء</label>
                <input
                  type="date"
                  value={formEndDate}
                  onChange={(e) => setFormEndDate(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">نهاية فترة التجربة</label>
                <input
                  type="date"
                  value={formProbationDate}
                  onChange={(e) => setFormProbationDate(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                />
              </div>
            </div>

            {/* Financials & Currency */}
            <div className="rounded-xl border border-navy-200 bg-navy-50/30 p-3">
              <div className="mb-2 text-xs font-bold text-navy-800">الأجر المالي والعملة:</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-navy-700">العملة *</label>
                  <select
                    value={formCurrency}
                    onChange={(e) => setFormCurrency(e.target.value)}
                    className="w-full rounded-xl border border-navy-200 bg-white p-2 text-sm outline-none"
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c}>
                        {c} ({CURRENCY_SHORT[c]})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-navy-700">الراتب الأساسي</label>
                  <input
                    type="number"
                    step="any"
                    value={formBaseSalary}
                    onChange={(e) => setFormBaseSalary(e.target.value)}
                    className="w-full rounded-xl border border-navy-200 bg-white p-2 text-sm outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-navy-700">نسبة الطبيب (%)</label>
                  <input
                    type="number"
                    step="any"
                    value={formCommissionRate}
                    onChange={(e) => setFormCommissionRate(e.target.value)}
                    className="w-full rounded-xl border border-navy-200 bg-white p-2 text-sm outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-navy-700">أجر الساعة</label>
                  <input
                    type="number"
                    step="any"
                    value={formHourlyRate}
                    onChange={(e) => setFormHourlyRate(e.target.value)}
                    className="w-full rounded-xl border border-navy-200 bg-white p-2 text-sm outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-navy-700">ساعات العمل أسبوعياً</label>
                  <input
                    type="number"
                    value={formHoursWeek}
                    onChange={(e) => setFormHoursWeek(e.target.value)}
                    className="w-full rounded-xl border border-navy-200 bg-white p-2 text-sm outline-none"
                  />
                </div>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">شروط وبنود العقد</label>
              <textarea
                rows={4}
                value={formClauses}
                onChange={(e) => setFormClauses(e.target.value)}
                placeholder="أدخل بنود العقد والالتزامات المتبادلة..."
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCreateModalOpen(false)}
                className="rounded-xl border border-navy-200 px-4 py-2 text-sm font-semibold text-navy-700 hover:bg-navy-50"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-xl bg-navy-800 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-navy-700 disabled:opacity-50"
              >
                {submitting ? "جاري الحفظ..." : "حفظ العقد"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Contract Details & Addenda Modal */}
      {selectedContract && contractDetails && (
        <Modal onClose={() => setSelectedContract(null)}>
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-navy-100 pb-3">
              <div>
                <h3 className="text-lg font-bold text-navy-900">{contractDetails.contract.title}</h3>
                <div className="text-xs text-navy-500">رقم العقد: {contractDetails.contract.contractNumber}</div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
                    contractDetails.contract.status === "active"
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-navy-100 text-navy-700"
                  }`}
                >
                  {HR_CONTRACT_STATUS_LABELS[contractDetails.contract.status] || contractDetails.contract.status}
                </span>
                <button
                  type="button"
                  onClick={() => setStatusModalOpen(true)}
                  className="rounded-lg bg-navy-800 px-2.5 py-1 text-xs font-semibold text-white hover:bg-navy-700"
                >
                  تغيير الحالة
                </button>
              </div>
            </div>

            {/* Contract Info */}
            <div className="grid grid-cols-2 gap-3 rounded-xl bg-navy-50/50 p-3 text-xs sm:grid-cols-4">
              <div>
                <span className="text-navy-500">الموظف:</span>
                <div className="font-semibold text-navy-800">{contractDetails.contract.staffName}</div>
              </div>
              <div>
                <span className="text-navy-500">نوع العقد:</span>
                <div className="font-semibold text-navy-800">
                  {HR_CONTRACT_KIND_LABELS[contractDetails.contract.templateKind]}
                </div>
              </div>
              <div>
                <span className="text-navy-500">الراتب / النسبة:</span>
                <div className="font-semibold text-navy-800">
                  {contractDetails.contract.baseSalaryMinor > 0
                    ? formatAmount(contractDetails.contract.baseSalaryMinor, contractDetails.contract.salaryCurrency)
                    : ""}
                  {contractDetails.contract.commissionRatePercent > 0
                    ? ` (${contractDetails.contract.commissionRatePercent}%)`
                    : ""}
                </div>
              </div>
              <div>
                <span className="text-navy-500">الفترة:</span>
                <div className="font-semibold text-navy-800">
                  {contractDetails.contract.startDate} → {contractDetails.contract.endDate || "مستمر"}
                </div>
              </div>
            </div>

            {/* Clauses */}
            {contractDetails.contract.termsPayload.clauses && (
              <div>
                <h4 className="mb-1 text-xs font-bold text-navy-700">بنود وشروط العقد:</h4>
                <div className="max-h-36 overflow-y-auto whitespace-pre-wrap rounded-xl border border-navy-100 bg-white p-3 text-xs text-navy-800">
                  {contractDetails.contract.termsPayload.clauses?.join("\n")}
                </div>
              </div>
            )}

            {/* Addenda List */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-xs font-bold text-navy-700">ملاحق العقد ({contractDetails.addenda.length}):</h4>
                <button
                  type="button"
                  onClick={() => { setAddendumSalary(selectedContract?.baseSalaryMinor ? toInputAmount(selectedContract.baseSalaryMinor,selectedContract.salaryCurrency) : ""); setAddendumCurrency(selectedContract?.salaryCurrency || "YER"); setAddendumModalOpen(true); }}
                  className="rounded-lg border border-navy-200 bg-white px-2.5 py-1 text-xs font-semibold text-navy-800 hover:bg-navy-50"
                >
                  + إضافة ملحق
                </button>
              </div>

              {contractDetails.addenda.length === 0 ? (
                <div className="rounded-xl border border-dashed border-navy-200 p-4 text-center text-xs text-navy-400">
                  لا توجد ملاحق مضافة لهذا العقد.
                </div>
              ) : (
                <div className="space-y-2">
                  {contractDetails.addenda.map((ad) => (
                    <div key={ad.id} className="rounded-xl border border-navy-100 bg-white p-3 text-xs">
                      <div className="flex items-center justify-between font-semibold text-navy-800">
                        <span>{ad.title} ({ad.contractNumber})</span>
                        <span className="text-navy-500 font-normal">سريان: {ad.startDate}</span>
                      </div>
                      <div className="mt-1 whitespace-pre-wrap text-navy-600">{ad.termsPayload.clauses?.join("\n")}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-between border-t border-navy-100 pt-3">
              <a
                href={`/print/hr/contracts/${contractDetails.contract.id}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-xl border border-navy-200 px-4 py-2 text-xs font-semibold text-navy-700 hover:bg-navy-50"
              >
                طباعة العقد الرسمي
              </a>
              <button
                type="button"
                onClick={() => setSelectedContract(null)}
                className="rounded-xl bg-navy-100 px-4 py-2 text-xs font-semibold text-navy-800 hover:bg-navy-200"
              >
                إغلاق
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Add Addendum Modal */}
      {addendumModalOpen && (
        <Modal onClose={() => setAddendumModalOpen(false)}>
          <form onSubmit={handleAddAddendum} className="space-y-3">
            <h3 className="text-base font-bold text-navy-900">إضافة ملحق للعقد</h3>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">عنوان الملحق *</label>
              <input
                required
                type="text"
                value={addendumTitle}
                onChange={(e) => setAddendumTitle(e.target.value)}
                placeholder="مثال: تعديل ساعات العمل أو إضافة بدل"
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">تاريخ السريان *</label>
              <input
                required
                type="date"
                value={addendumEffectiveDate}
                onChange={(e) => setAddendumEffectiveDate(e.target.value)}
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">نص وتفاصيل الملحق *</label>
              <textarea
                required
                rows={4}
                value={addendumContent}
                onChange={(e) => setAddendumContent(e.target.value)}
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              />
            </div>
            {(selectedContract?.baseSalaryMinor ?? 0) > 0 && <div className="grid grid-cols-2 gap-3">
              <label>راتب الملحق الشهري<input type="number" min="0" step="any" value={addendumSalary} onChange={(e)=>setAddendumSalary(e.target.value)} className="w-full rounded-xl border p-2" /></label>
              <label>عملة الملحق<select value={addendumCurrency} onChange={(e)=>setAddendumCurrency(e.target.value as Currency)} className="w-full rounded-xl border p-2">{CURRENCIES.map((c)=><option key={c} value={c}>{c}</option>)}</select></label>
              <p className="col-span-2 text-xs">تغيير الأجر أثناء الشهر يحجب اعتماد المسير إلى أن تعتمد سياسة التقسيم.</p>
            </div>}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setAddendumModalOpen(false)}
                className="rounded-xl border border-navy-200 px-3 py-1.5 text-xs font-semibold text-navy-700"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-xl bg-navy-800 px-4 py-1.5 text-xs font-semibold text-white"
              >
                {submitting ? "جاري الحفظ..." : "حفظ الملحق"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Status Transition Modal */}
      {statusModalOpen && selectedContract && (
        <Modal onClose={() => setStatusModalOpen(false)}>
          <div className="space-y-3">
            <h3 className="text-base font-bold text-navy-900">تغيير حالة العقد</h3>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">الحالة الجديدة *</label>
              <select
                value={targetStatus}
                onChange={(e) => setTargetStatus(e.target.value as HrContractStatus)}
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              >
                {Object.entries(HR_CONTRACT_STATUS_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">سبب التغيير / ملاحظة</label>
              <textarea
                rows={2}
                value={statusReason}
                onChange={(e) => setStatusReason(e.target.value)}
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setStatusModalOpen(false)}
                className="rounded-xl border border-navy-200 px-3 py-1.5 text-xs font-semibold text-navy-700"
              >
                إلغاء
              </button>
              <button
                type="button"
                onClick={handleTransitionStatus}
                disabled={submitting}
                className="rounded-xl bg-navy-800 px-4 py-1.5 text-xs font-semibold text-white"
              >
                {submitting ? "جاري الاعتماد..." : "تأكيد التغيير"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
