"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useHrNavigation, useHrStaffSelection } from "./HrNavigation";
import { Modal } from "@/components/Modal";
import type { SessionInfo } from "@/components/SessionProvider";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { readBoundedContractSaveReceipt, confirmsContractSave, snapshotContractSave, type ContractSaveAdmissionView, type ContractSaveAdmissionLease, type PendingContractSave } from "@/lib/hr-contract-save-receipt";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { clinicDateString } from "@/lib/schedule";
import {
  HR_CONTRACT_KIND_LABELS, HR_CANONICAL_CONTRACT_KINDS, hrContractCompensationKind, hrContractPayMissing,
  HR_CONTRACT_STATUS_LABELS,
  hrContractNextStatuses,hrContractHasApproval,hrContractEditable,
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
  compensationKind: "salary"|"commission"|"salary_commission";
  salaryPeriod: string|null;
  doctorPartyId: number|null;
  baseSalaryMinor: number|null;
  salaryCurrency: Currency|null;
  commissionRatePercent: number|null;
  hourlyRate: number;
  workingHoursPerWeek: number;
  termsPayload: { clauses?: string[]; workingHoursPerWeek?:number|null; hourlyRateMinor?:number|null; [key:string]:unknown };
  approvedBy: string | null;
  approvedAt: string | null;
  addendaCount?: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
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

export function HrContractsPanel({ session, pendingSave, saveAdmission, mountSaveAdmission, onReserveSave, onSettleSave }: {
  session: SessionInfo | null;
  pendingSave: PendingContractSave | undefined;
  saveAdmission: ContractSaveAdmissionView;
  mountSaveAdmission: (view: ContractSaveAdmissionView) => ContractSaveAdmissionLease;
  onReserveSave: (request: PendingContractSave, lease: ContractSaveAdmissionLease) => boolean;
  onSettleSave: (owner: string, expectedToken: string, request?: PendingContractSave) => boolean;
}) {
  const navigation = useHrNavigation();
  const [selectedStaff, setSelectedStaff] = useHrStaffSelection();
  const alive = useRef(false), readSequence = useRef(0), detailSequence = useRef(0);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; readSequence.current++; detailSequence.current++; }; }, []);
  const saveAdmissionLease = useRef<ContractSaveAdmissionLease | undefined>(undefined);
  useLayoutEffect(() => {
    const lease = mountSaveAdmission(saveAdmission);
    saveAdmissionLease.current = lease;
    return () => { lease.detach(); if (saveAdmissionLease.current === lease) saveAdmissionLease.current = undefined; };
  }, [mountSaveAdmission, saveAdmission]);
  const currentSaveAdmission = () => {
    const lease = saveAdmissionLease.current;
    return lease?.view === saveAdmission && lease.canAdmit() ? lease : undefined;
  };
  const [contracts, setContracts] = useState<ContractItem[]>([]);
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [kindFilter, setKindFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modals state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editingDraft,setEditingDraft] = useState<ContractItem|null>(null);
  const [selectedContract, setSelectedContract] = useState<ContractItem | null>(null);
  const [contractDetails, setContractDetails] = useState<{ contract: ContractItem; addenda: AddendumItem[] } | null>(null);
  const [addendumModalOpen, setAddendumModalOpen] = useState(false);
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [targetStatus, setTargetStatus] = useState<HrContractStatus>("approved");
  const [statusReason, setStatusReason] = useState("");

  // Create form state
  const [formStaffId, setFormStaffId] = useState(selectedStaff);
  const [formTitle, setFormTitle] = useState("");
  const [formKind, setFormKind] = useState<HrContractKind>("support_staff");
  const [formStartDate, setFormStartDate] = useState(() => clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));
  const [formEndDate, setFormEndDate] = useState("");
  const [formProbationDate, setFormProbationDate] = useState("");
  const [formCurrency, setFormCurrency] = useState("");
  const [formSalaryPeriod,setFormSalaryPeriod] = useState("");
  const [doctorParties,setDoctorParties] = useState<Array<{id:number;name:string;commissionPercent:number}>>([]);
  const [formDoctorPartyId,setFormDoctorPartyId] = useState("");
  const [addendumSalary,setAddendumSalary] = useState("");
  const [addendumCurrency,setAddendumCurrency] = useState<Currency>("YER");
  useEffect(()=>{ void fetch("/api/parties?kind=doctor").then(async(r)=>{if(r.ok) setDoctorParties(await r.json());}).catch(()=>{}); },[]);
  const [formBaseSalary, setFormBaseSalary] = useState("");
  const [formCommissionRate, setFormCommissionRate] = useState("");
  const [formHourlyRate, setFormHourlyRate] = useState("");
  const [formHoursWeek, setFormHoursWeek] = useState("");
  const [formClauses, setFormClauses] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reviewedPending, setReviewedPending] = useState<string | null>(null);
  const activeSave = useRef(pendingSave);
  const previousSave = useRef(pendingSave?.token);
  const saveBusy = submitting || pendingSave?.phase === "awaiting";
  const saveLocked = saveBusy || Boolean(pendingSave);
  const formSaveError = saveError ?? (pendingSave?.phase === "uncertain" ? "نتيجة حفظ العقد غير مؤكدة. قد يكون الحفظ تم؛ لا تُعِد الإرسال قبل مراجعة قائمة العقود." : null);
  useEffect(() => {
    activeSave.current = pendingSave;
    if (previousSave.current && !pendingSave) { setCreateModalOpen(false); setEditingDraft(null); }
    previousSave.current = pendingSave?.token;
  }, [pendingSave]);

  // Addendum form state
  const [addendumTitle, setAddendumTitle] = useState("");
  const [addendumEffectiveDate, setAddendumEffectiveDate] = useState(() => clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));
  const [addendumContent, setAddendumContent] = useState("");

  const loadContracts = useCallback(async () => {
    if (!alive.current) return;
    const sequence = ++readSequence.current;
    setLoading(true); setContracts([]);
    try {
      const params = new URLSearchParams();
      if (selectedStaff) params.set("staffId", selectedStaff);
      if (statusFilter) params.set("status", statusFilter);
      if (kindFilter) params.set("contractKind", kindFilter);
      const res = await fetch(`/api/hr/contracts?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error("تعذّر تحميل العقود.");
      const data = await res.json();
      if (!alive.current || sequence !== readSequence.current) return;
      if (!Array.isArray(data) || (selectedStaff && data.some(row => String(row.staffId) !== selectedStaff))) throw new Error("تعذّر التحقق من هوية العقود.");
      setContracts(data);
      setError(null);
    } catch (err: any) {
      if (alive.current && sequence === readSequence.current) setError(err?.message || "حدث خطأ أثناء تحميل العقود.");
    } finally {
      if (alive.current && sequence === readSequence.current) setLoading(false);
    }
  }, [statusFilter, kindFilter, selectedStaff]);
  useLayoutEffect(() => { setContracts([]); setLoading(true); return () => { readSequence.current++; }; }, [loadContracts]);

  const loadStaff = useCallback(async () => {
    try {
      const res = await fetch("/api/hr/staff", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (alive.current) setStaffOptions(data);
      }
    } catch {
      // Ignored
    }
  }, []);

  useEffect(() => {
    void loadContracts();
    void loadStaff();
  }, [loadContracts, loadStaff]);

  const readDetails = useCallback(async (id: string) => {
    if (!alive.current) return;
    const sequence = ++detailSequence.current;
    setSelectedContract(null); setContractDetails(null);
    try {
      const res = await fetch(`/api/hr/contracts/${id}`, { cache: "no-store" });
      if (!res.ok) throw new Error("تعذّر تحميل العقد المحدد.");
      const data = await res.json();
      if (String(data?.contract?.id) !== id || (selectedStaff && String(data.contract.staffId) !== selectedStaff)) throw new Error("العقد لا يطابق الموظف المحدد.");
      if (!alive.current || sequence !== detailSequence.current) return;
      setSelectedContract(data.contract); setContractDetails(data);
    } catch (err) {
      if (alive.current && sequence === detailSequence.current) setError(err instanceof Error ? err.message : "تعذّر تحميل العقد.");
    }
  }, [selectedStaff]);
  const openDetails = (contract: ContractItem) => {
    const id = String(contract.id);
    if (navigation && navigation.contractId !== id) navigation.selectContract(id);
    else void readDetails(id);
  };
  const closeDetails = () => {
    detailSequence.current++; setSelectedContract(null); setContractDetails(null);
    if (navigation) navigation.selectContract("");
  };
  useEffect(() => {
    // A saved detail link must not cover the owner's unresolved save review
    // when this panel remounts. Explicit detail clicks remain available.
    if (navigation?.contractId && !activeSave.current) void readDetails(navigation.contractId);
  }, [navigation?.contractId, readDetails]);

  const applyTemplate = (template: "fixed" | "doctor_pct" | "doctor_salary" | "hybrid" | "probation") => {
    const presets = {
      fixed:{kind:"support_staff",title:"عقد موظف مساند براتب"},
      doctor_pct:{kind:"doctor_percentage",title:"عقد طبيب بنسبة"},
      doctor_salary:{kind:"doctor_salary",title:"عقد طبيب براتب"},
      hybrid:{kind:"doctor_hybrid",title:"عقد طبيب براتب ونسبة"},
      probation:{kind:"support_staff",title:"عقد موظف مساند خلال فترة التجربة"},
    } as const;
    setFormKind(presets[template].kind);setFormTitle(presets[template].title);
    // Classification only: preserve explicitly entered terms; never invent pay,
    // probation dates, working hours, or contractual clauses.
  };

  const openDraftEditor = (contract:ContractItem) => {
    if (activeSave.current || pendingSave) { setError("راجع طلب حفظ العقد المعلق قبل بدء تعديل آخر."); return; }
    if(!hrContractEditable(contract))return;
    setEditingDraft(contract);setFormStaffId(String(contract.staffId));setFormTitle(contract.title);setFormKind(contract.templateKind);
    setFormStartDate(contract.startDate);setFormEndDate(contract.endDate??"");setFormProbationDate(contract.probationEndDate??"");
    setFormCurrency(contract.salaryCurrency??"");setFormSalaryPeriod(contract.salaryPeriod??"");
    setFormBaseSalary(contract.baseSalaryMinor!==null&&contract.salaryCurrency?toInputAmount(contract.baseSalaryMinor,contract.salaryCurrency):"");
    setFormCommissionRate(contract.commissionRatePercent===null?"":String(contract.commissionRatePercent));setFormDoctorPartyId(contract.doctorPartyId===null?"":String(contract.doctorPartyId));
    setFormHoursWeek(contract.termsPayload.workingHoursPerWeek==null?"":String(contract.termsPayload.workingHoursPerWeek));
    setFormHourlyRate(contract.termsPayload.hourlyRateMinor!=null&&contract.salaryCurrency?toInputAmount(contract.termsPayload.hourlyRateMinor,contract.salaryCurrency):"");
    setFormClauses(contract.termsPayload.clauses?.join("\n")??"");setSelectedContract(null);setContractDetails(null);setCreateModalOpen(true);
  };

  const reopenPendingSave = () => {
    if (!pendingSave) return;
    const payload = pendingSave.payload;
    setEditingDraft(null);setFormStaffId(payload.staffId);setFormTitle(payload.title);setFormKind(payload.templateKind);
    setFormStartDate(payload.startDate);setFormEndDate(payload.endDate??"");setFormProbationDate(payload.probationEndDate??"");
    setFormCurrency(payload.salaryCurrency??"");setFormSalaryPeriod(payload.salaryPeriod??"");
    setFormBaseSalary(payload.baseSalaryMinor!==null&&payload.salaryCurrency?toInputAmount(payload.baseSalaryMinor,payload.salaryCurrency as Currency):"");
    setFormCommissionRate(payload.commissionRatePercent===null?"":String(payload.commissionRatePercent));setFormDoctorPartyId(payload.doctorPartyId===null?"":String(payload.doctorPartyId));
    setFormHoursWeek(payload.termsPayload.workingHoursPerWeek==null?"":String(payload.termsPayload.workingHoursPerWeek));
    setFormHourlyRate(payload.termsPayload.hourlyRateMinor!=null&&payload.salaryCurrency?toInputAmount(Number(payload.termsPayload.hourlyRateMinor),payload.salaryCurrency as Currency):"");
    setFormClauses(Array.isArray(payload.termsPayload.clauses)?payload.termsPayload.clauses.join("\n"):"");
    setCreateModalOpen(true);
  };

  const handleCreateContract = async (e: React.FormEvent) => {
    e.preventDefault();
    const lease = currentSaveAdmission();
    if (!lease || activeSave.current || pendingSave || submitting) return;
    if (!session || !formStaffId || !formTitle) { alert("يرجى تعبئة الحقول الإلزامية."); return; }
    if ((formBaseSalary.trim() || formHourlyRate.trim()) && !formCurrency) { alert("اختر عملة المبلغ صراحةً."); return; }
    let request: PendingContractSave | undefined;
    let confirmed = false;
    setSubmitting(true);setSaveError(null);
    try {
      const snapshot = snapshotContractSave({
        token: newIdempotencyKey("hr-contract-intent"), owner: `${session.username}\u0000${session.role}`, phase: "awaiting",
        method: editingDraft ? "PATCH" : "POST", path: editingDraft ? `/api/hr/contracts/${editingDraft.id}` : "/api/hr/contracts",
        expectedId: editingDraft ? Number(editingDraft.id) : null,
        expectedContractNumber: editingDraft?.contractNumber ?? null,
        expectedStatus: editingDraft?.status ?? "draft", expectedCreator: editingDraft?.createdBy ?? session.username,
        payload: {
          ...(editingDraft?{expectedUpdatedAt:editingDraft.updatedAt}:{}),
          staffId: formStaffId, title: formTitle, templateKind: formKind,
          compensationKind: hrContractCompensationKind(formKind), startDate: formStartDate,
          endDate: formEndDate || null, probationEndDate: formProbationDate || null,
          salaryCurrency: formCurrency || null, salaryPeriod: formSalaryPeriod || null,
          baseSalaryMinor: formBaseSalary.trim() ? parseAmount(formBaseSalary, formCurrency as Currency) : null,
          commissionRatePercent: formCommissionRate.trim() ? Number(formCommissionRate) : null,
          doctorPartyId: formDoctorPartyId ? Number(formDoctorPartyId) : null,
          termsPayload: { ...editingDraft?.termsPayload, clauses: formClauses.split("\n").filter(Boolean), workingHoursPerWeek: formHoursWeek.trim() ? Number(formHoursWeek) : null, hourlyRateMinor: formHourlyRate.trim() ? parseAmount(formHourlyRate, formCurrency as Currency) : null },
        },
      });
      // The long-lived owner reserves synchronously before fetch, independently
      // of React's next render or this tab's lifetime. This is not a replay key.
      if (!onReserveSave(snapshot, lease)) throw new Error("يوجد طلب حفظ عقد معلق؛ راجعه قبل بدء طلب آخر.");
      request = snapshot;activeSave.current = snapshot;
      const submitted = request;
      const { status, receipt } = await readBoundedContractSaveReceipt(async (signal) => {
        const res = await fetch(submitted.path, { method: submitted.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(submitted.payload), signal });
        // Headers alone do not establish a complete, matching response. This
        // read-only continuation cannot release intent after the deadline wins.
        const receipt: unknown = await res.json();
        return { status: res.status, receipt };
      });
      if (status !== (request.method === "POST" ? 201 : 200) || !confirmsContractSave(receipt, request)) {
        throw new Error("تعذّر التحقق من إيصال حفظ العقد.");
      }
      confirmed = true;
      if (onSettleSave(request.owner, request.token) && lease.canAdmit()) {
        setCreateModalOpen(false);setEditingDraft(null);setSaveError(null);
        void loadContracts();
      }
    } catch (err: any) {
      if (request) {
        const uncertain = snapshotContractSave({ ...request, phase: "uncertain" });
        activeSave.current = uncertain;
        onSettleSave(request.owner, request.token, uncertain);
        if (lease.canAdmit()) setSaveError("نتيجة حفظ العقد غير مؤكدة. قد يكون الحفظ تم؛ لا تُعِد الإرسال قبل مراجعة قائمة العقود.");
      } else if (lease.canAdmit()) setSaveError(err?.message || "تعذّر إعداد طلب حفظ العقد.");
    } finally {
      if (!request || confirmed) activeSave.current = undefined;
      if (lease.canAdmit()) setSubmitting(false);
    }
  };

  const handleTransitionStatus = async () => {
    if (!selectedContract) return;
    if(!hrContractNextStatuses(contractDetails?.contract??selectedContract).includes(targetStatus))return;
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
      <label className="grid min-w-0 gap-1 text-sm">عقود الموظف<select aria-label="عقود الموظف" value={selectedStaff} onChange={event => setSelectedStaff(event.target.value)} className="w-full min-w-0 max-w-full rounded-xl border p-2"><option value="">كل الموظفين</option>{staffOptions.map(staff => <option key={staff.id} value={staff.id}>{staff.fullName}</option>)}</select></label>
      {pendingSave && <div role="status" className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <p>{pendingSave.phase === "awaiting" ? "جارٍ انتظار إيصال حفظ العقد؛ لا تُعِد الإرسال." : createModalOpen ? "طلب حفظ العقد معلق للمراجعة." : "نتيجة حفظ العقد غير مؤكدة. قد يكون الحفظ تم؛ لا تُعِد الإرسال قبل مراجعة قائمة العقود."}</p>
        <p>الطلب محفوظ في ذاكرة صفحة الموارد البشرية لهذا المستخدم فقط. تغيير التبويب أو إغلاق نافذة العقد لا يمحوه، لكن تحديث الصفحة أو مغادرتها يفقده؛ راجع القائمة أولاً لتجنب التكرار.</p>
        <button type="button" onClick={reopenPendingSave} className="rounded-lg border px-3 py-2">عرض طلب الحفظ المعلق</button>
        <button type="button" disabled={saveBusy} onClick={() => { setCreateModalOpen(false); setReviewedPending(pendingSave.token); void loadContracts(); }} className="rounded-lg border px-3 py-2 disabled:opacity-50">مراجعة قائمة العقود</button>
        {reviewedPending === pendingSave.token && <button type="button" disabled={saveBusy} onClick={() => {
          if (!currentSaveAdmission()) return;
          if (!window.confirm("قد يكون طلب الحفظ السابق قد نُفّذ. بدء طلب جديد لا يتحقق من الطلب السابق وقد ينشئ عقدًا مكررًا. هل راجعت قائمة العقود وتريد بدء طلب مستقل؟")) return;
          if (currentSaveAdmission() && onSettleSave(pendingSave.owner, pendingSave.token)) { activeSave.current = undefined; setReviewedPending(null); setSaveError(null); setCreateModalOpen(false); setEditingDraft(null); }
        }} className="rounded-lg border px-3 py-2">بدء طلب جديد بعد المراجعة</button>}
      </div>}
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
              if (activeSave.current || pendingSave) { reopenPendingSave(); return; }
              setSaveError(null);
              setEditingDraft(null);setFormTitle("");setFormStaffId("");setFormStartDate(clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));setFormKind("support_staff");setFormBaseSalary("");setFormCommissionRate("");setFormCurrency("");setFormSalaryPeriod("");setFormDoctorPartyId("");setFormHoursWeek("");setFormHourlyRate("");setFormProbationDate("");setFormEndDate("");setFormClauses("");
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
          className="min-w-0 max-w-full rounded-xl border border-navy-200 bg-white px-3 py-2 text-sm text-navy-800 outline-none"
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
          className="min-w-0 max-w-full rounded-xl border border-navy-200 bg-white px-3 py-2 text-sm text-navy-800 outline-none"
        >
          <option value="">جميع أنواع العقود</option>
          {HR_CANONICAL_CONTRACT_KINDS.map((k) => (
            <option key={k} value={k}>
              {HR_CONTRACT_KIND_LABELS[k]}
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
                      {c.baseSalaryMinor !== null && c.salaryCurrency !== null && (
                        <div>
                          {formatAmount(c.baseSalaryMinor, c.salaryCurrency as Currency)}{" "}
                          {CURRENCY_SHORT[c.salaryCurrency as Currency] || c.salaryCurrency}
                        </div>
                      )}
                      {c.commissionRatePercent !== null && (
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
        <Modal alignTop busy={saveBusy} onClose={() => setCreateModalOpen(false)}>
          <form onSubmit={handleCreateContract} className="mx-auto w-full min-w-0 max-w-3xl rounded-2xl border border-navy-100 bg-white p-4 shadow-raised sm:p-5 [overflow-wrap:anywhere] [&_div]:min-w-0 [&_fieldset]:min-w-0 [&_input]:min-w-0 [&_select]:min-w-0 [&_textarea]:min-w-0 space-y-4">
            <h3 className="text-lg font-bold text-navy-900">{editingDraft||pendingSave?.method==="PATCH"?"استكمال / تعديل المسودة":"إنشاء عقد وظيفي جديد"}</h3>

            {formSaveError && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{formSaveError}</p>}
            {/* Template Selector */}
            <fieldset disabled={Boolean(editingDraft) || saveLocked} className="rounded-xl border border-navy-100 bg-navy-50/50 p-3">
              <div className="mb-2 text-xs font-semibold text-navy-600">اختر تصنيف العقد؛ الأجر والبنود غير مسجلة حتى تدخلها صراحةً:</div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => applyTemplate("fixed")}
                  className="rounded-lg border border-navy-200 bg-white px-2.5 py-1 text-xs font-medium text-navy-800 hover:bg-navy-100"
                >
                  عقد موظف مساند (راتب)
                </button>
                <button
                  type="button"
                  onClick={() => applyTemplate("doctor_pct")}
                  className="rounded-lg border border-navy-200 bg-white px-2.5 py-1 text-xs font-medium text-navy-800 hover:bg-navy-100"
                >
                  عقد طبيب (نسبة)
                </button>
                <button type="button" onClick={() => applyTemplate("doctor_salary")} className="rounded-lg border border-navy-200 bg-white px-2.5 py-1 text-xs">عقد طبيب (راتب)</button>
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
            </fieldset>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">الموظف *</label>
                <select
                  required
                  disabled={Boolean(editingDraft) || saveLocked} aria-label="الموظف" value={formStaffId}
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
              <select disabled={saveLocked} value={formDoctorPartyId} onChange={(e)=>setFormDoctorPartyId(e.target.value)} className="w-full rounded-xl border p-2">
                <option value="">اختر جهة الطبيب للعقد بنسبة أو مختلط</option>{doctorParties.map((d)=><option key={d.id} value={d.id}>{d.name} ({d.commissionPercent}%)</option>)}
              </select>
            </label>
            <p className="text-xs text-navy-500">العمولة تُحتسب من محرك العمولات القائم. اختلاف نسبة العقد عن السياسة السارية يحجب اعتماد المسير.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">مسمى العقد *</label>
                <input disabled={saveLocked}
                  required
                  type="text"
                  aria-label="مسمى العقد" value={formTitle}
                  onChange={(e) => setFormTitle(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">نوع العقد *</label>
                <select
                  disabled={Boolean(editingDraft) || saveLocked} aria-label="نوع العقد" value={formKind}
                  onChange={(e) => setFormKind(e.target.value as HrContractKind)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                >
                  {HR_CANONICAL_CONTRACT_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {HR_CONTRACT_KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">تاريخ البدء *</label>
                <input disabled={saveLocked}
                  required
                  type="date"
                  aria-label="تاريخ البدء" value={formStartDate}
                  onChange={(e) => setFormStartDate(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">تاريخ الانتهاء</label>
                <input disabled={saveLocked}
                  type="date"
                  aria-label="تاريخ الانتهاء" value={formEndDate}
                  onChange={(e) => setFormEndDate(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-navy-700">نهاية فترة التجربة</label>
                <input disabled={saveLocked}
                  type="date"
                  aria-label="نهاية فترة التجربة" value={formProbationDate}
                  onChange={(e) => setFormProbationDate(e.target.value)}
                  className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
                />
              </div>
            </div>

            <p className="text-xs text-navy-600">يمكن حفظ المسودة ناقصة؛ يلزم إكمال شروط الأجر صراحةً قبل الاعتماد. اختيار جهة الطبيب لا يملأ نسبة العقد تلقائيًا.</p>
            <label className="block text-xs font-semibold">دورية الراتب
              <select disabled={saveLocked} aria-label="دورية الراتب" value={formSalaryPeriod} onChange={e=>setFormSalaryPeriod(e.target.value)} className="w-full rounded-xl border p-2">
                <option value="">غير مسجلة</option><option value="monthly">شهري</option><option value="weekly">أسبوعي</option><option value="daily">يومي</option><option value="per_shift">لكل وردية</option>
              </select>
            </label>
            {/* Financials & Currency */}
            <div className="rounded-xl border border-navy-200 bg-navy-50/30 p-3">
              <div className="mb-2 text-xs font-bold text-navy-800">الأجر المالي والعملة:</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-navy-700">العملة *</label>
                  <select disabled={saveLocked}
                    aria-label="عملة الأجر" value={formCurrency}
                    onChange={(e) => setFormCurrency(e.target.value)}
                    className="w-full rounded-xl border border-navy-200 bg-white p-2 text-sm outline-none"
                  >
                    <option value="">غير مسجلة</option>
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c}>
                        {c} ({CURRENCY_SHORT[c]})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-navy-700">الراتب الأساسي</label>
                  <input disabled={saveLocked}
                    type="number"
                    step="any"
                    aria-label="الراتب الأساسي" value={formBaseSalary}
                    onChange={(e) => setFormBaseSalary(e.target.value)}
                    className="w-full rounded-xl border border-navy-200 bg-white p-2 text-sm outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-navy-700">نسبة الطبيب (%)</label>
                  <input disabled={saveLocked}
                    type="number"
                    step="any"
                    aria-label="نسبة الطبيب (%)" value={formCommissionRate}
                    onChange={(e) => setFormCommissionRate(e.target.value)}
                    className="w-full rounded-xl border border-navy-200 bg-white p-2 text-sm outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-navy-700">أجر الساعة</label>
                  <input disabled={saveLocked}
                    type="number"
                    step="any"
                    aria-label="أجر الساعة" value={formHourlyRate}
                    onChange={(e) => setFormHourlyRate(e.target.value)}
                    className="w-full rounded-xl border border-navy-200 bg-white p-2 text-sm outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-navy-700">ساعات العمل أسبوعياً</label>
                  <input disabled={saveLocked}
                    type="number"
                    aria-label="ساعات العمل أسبوعياً" value={formHoursWeek}
                    onChange={(e) => setFormHoursWeek(e.target.value)}
                    className="w-full rounded-xl border border-navy-200 bg-white p-2 text-sm outline-none"
                  />
                </div>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">شروط وبنود العقد</label>
              <textarea disabled={saveLocked}
                aria-label="شروط وبنود العقد"
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
                disabled={saveBusy}
                className="rounded-xl border border-navy-200 px-4 py-2 text-sm font-semibold text-navy-700 hover:bg-navy-50"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={saveLocked}
                className="rounded-xl bg-navy-800 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-navy-700 disabled:opacity-50"
              >
                {saveBusy ? "جاري الحفظ..." : "حفظ العقد"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Contract Details & Addenda Modal */}
      {selectedContract && contractDetails && (
        <Modal alignTop onClose={closeDetails}>
          <div className="mx-auto w-full min-w-0 max-w-3xl rounded-2xl border border-navy-100 bg-white p-4 shadow-raised sm:p-5 [overflow-wrap:anywhere] [&_div]:min-w-0 [&_fieldset]:min-w-0 [&_input]:min-w-0 [&_select]:min-w-0 [&_textarea]:min-w-0 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-navy-100 pb-3">
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
                  disabled={hrContractNextStatuses(contractDetails.contract).length===0}
                  onClick={() => {const next=hrContractNextStatuses(contractDetails.contract)[0];if(next){setTargetStatus(next);setStatusModalOpen(true);}}}
                  className="rounded-lg bg-navy-800 px-2.5 py-1 text-xs font-semibold text-white hover:bg-navy-700"
                >
                  تغيير الحالة
                </button>
              </div>
            </div>

            {hrContractPayMissing(contractDetails.contract).length>0 && <p role="status" className="text-sm text-amber-800">شروط الأجر غير مكتملة: {hrContractPayMissing(contractDetails.contract).join("، ")}. يلزم إكمالها قبل الاعتماد.</p>}
            {hrContractEditable(contractDetails.contract) && <button type="button" onClick={()=>openDraftEditor(contractDetails.contract)} className="rounded-lg border px-3 py-2 text-sm">استكمال / تعديل المسودة</button>}
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
                  {contractDetails.contract.baseSalaryMinor !== null && contractDetails.contract.salaryCurrency !== null
                    ? formatAmount(contractDetails.contract.baseSalaryMinor, contractDetails.contract.salaryCurrency)
                    : ""}
                  {contractDetails.contract.commissionRatePercent !== null
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
                  disabled={!hrContractHasApproval(contractDetails.contract)}
                  onClick={() => { setAddendumSalary(selectedContract?.baseSalaryMinor != null && selectedContract.salaryCurrency ? toInputAmount(selectedContract.baseSalaryMinor,selectedContract.salaryCurrency) : ""); setAddendumCurrency(selectedContract?.salaryCurrency || "YER"); setAddendumModalOpen(true); }}
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
                onClick={closeDetails}
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
        <Modal alignTop onClose={() => setAddendumModalOpen(false)}>
          <form onSubmit={handleAddAddendum} className="mx-auto w-full min-w-0 max-w-3xl rounded-2xl border border-navy-100 bg-white p-4 shadow-raised sm:p-5 [overflow-wrap:anywhere] [&_div]:min-w-0 [&_fieldset]:min-w-0 [&_input]:min-w-0 [&_select]:min-w-0 [&_textarea]:min-w-0 space-y-3">
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
        <Modal alignTop onClose={() => setStatusModalOpen(false)}>
          <div className="mx-auto w-full min-w-0 max-w-3xl rounded-2xl border border-navy-100 bg-white p-4 shadow-raised sm:p-5 [overflow-wrap:anywhere] [&_div]:min-w-0 [&_fieldset]:min-w-0 [&_input]:min-w-0 [&_select]:min-w-0 [&_textarea]:min-w-0 space-y-3">
            <h3 className="text-base font-bold text-navy-900">تغيير حالة العقد</h3>
            <div>
              <label className="mb-1 block text-xs font-semibold text-navy-700">الحالة الجديدة *</label>
              <select
                value={targetStatus}
                onChange={(e) => setTargetStatus(e.target.value as HrContractStatus)}
                className="w-full rounded-xl border border-navy-200 p-2.5 text-sm outline-none"
              >
                {hrContractNextStatuses(contractDetails?.contract??selectedContract).map(k => (
                  <option key={k} value={k}>
                    {HR_CONTRACT_STATUS_LABELS[k]}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-navy-500">الاعتماد إداري ولا يسجل توقيعًا. بعد الاعتماد تُعدّل البنود بملحق، ولا يعود الأصل إلى مسودة.</p>
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
