"use client";
import { blankPrescriptionRow, appendPrescriptionSelection, canAcceptPrescriptionSelection, retireDraftDoseReferenceAt } from "@/lib/prescription-draft-rows";
import {openSavedPrescriptionPrint} from "@/lib/prescription-print-opening";
import { PrescriptionStaleReferenceNotice } from "./PrescriptionStaleReferenceNotice";
import { PrescriptionDoseProfiles } from "./PrescriptionDoseProfiles";
import { prescriberUnavailableMessage } from "@/lib/prescription-prescriber-feedback";
import { canonicalPrescriptionCommand } from "@/lib/prescription-command";
import { getOrCreatePrescriptionCommand, readPrescriptionCommand, prescriptionCommandStorageKey, createPrescriptionOperationFence, type PrescriptionOperation, type PendingPrescriptionCommand } from "@/lib/prescription-command-client";

import { changedMedicationSelection, createManualMedicationSelection, manualMedicationSelectionError } from "@/lib/prescription-medication-selection";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSession } from "./SessionProvider";
import { Icon } from "./Icon";
import { evaluatePrescriptionSafety, type DrugSafetyAlert } from "@/lib/medication-safety";
import { PrescriptionClinicCatalog } from "./PrescriptionClinicCatalog";
import { PrescriptionMedicationLibrary } from "./PrescriptionMedicationLibrary";
import { PROCEDURE_TEMPLATES } from "@/lib/prescription-procedure-templates";
import { MAX_ITEMS, sanitizeRxItems, checkPrescriptionDraft } from "@/lib/prescription";
import { interpretPrescriptionSaveResponse } from "@/lib/prescription-save-workflow";

/**
 * الوصفة الطبية — الدواء بالإنجليزية والتعليمات بلغة المريض.
 *
 * اسم الدواء وعياره وشكله وعدد مراته ومدته يُكتب لاتينيًا دائمًا: الصيدلاني
 * والمرجع الدوائي والطبيب الاستشاري كلهم يقرؤون الإنجليزية، والاسم العربي
 * للدواء يختلف من بلدٍ لبلد فيصير ترجمةُ الاسم خطأً دوائيًا. أما التعليمات —
 * متى يؤخذ وماذا يتجنب — فهي كلامٌ للمريض، فيختار الطبيب لغتها: عربية، أو
 * إنجليزية، أو الاثنتين معًا لبيئةٍ ثنائية اللغة.
 */

export type RxItem = import("@/lib/prescription").RxItem;

/** لغة التعليمات على الروشتة المطبوعة: عربي، إنجليزي، أو كلاهما. */
export type InstructionsLang = "both" | "ar" | "en";

const LANG_LABELS: { key: InstructionsLang; label: string }[] = [
  { key: "both", label: "عربي + English" },
  { key: "ar", label: "عربي" },
  { key: "en", label: "English" },
];

/* قوالب الأدوية الجاهزة أُزيلت كليًا (مراجعة الجولة الثانية — Blocker A):
 * كان هنا COMMON_TEMPLATES تحمل regimens ثابتة (Augmentin بعد الخلع الجراحي،
 * Amoxicillin+Metronidazole للخراج، وقاية الزراعة، شراب أطفال…) تُحمّل
 * بضغطةٍ واحدة بلا أي سياق سريري. صارت القوالب في lib/prescription-procedure-templates
 * «إجراءات وتشخيصات» تُعبّئ الحالة والملاحظات فقط — اختيار الدواء والجرعة
 * بيد الطبيب، ومع قائمة تحققٍ سريري تظهر قبل الوصف. */

interface PrescriptionModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** اختياري (من عمل الوكيل المساعد): وصفة من مساحة الزيارة قد لا تملك ملفًّا
   * مرتبطًا بعد — فتُكتب بيانات المريض نصًّا حتى يُربط. */
  patientId?: number | null;
  visitId?: number | null;
  patientName: string;
  patientPhone?: string | null;
  medicalAlert?: string | null;
  /** ClinicalVisit distinguishes an unread/unavailable file from verified empty fields. */
  patientContextStatus?: "loading" | "unavailable" | "ready";
  defaultDiagnosis?: string;
  defaultDoctorName?: string;
  defaultDoctorPartyId?: number | null;
}

export function PrescriptionModal({
  isOpen,
  onClose,
  patientId,
  visitId,
  patientName,
  patientPhone,
  medicalAlert,
  patientContextStatus,
  defaultDiagnosis = "",
  defaultDoctorName = "",
  defaultDoctorPartyId = null,
}: PrescriptionModalProps) {
  // A closed modal stays mounted while the visit diagnosis is loaded/edited.
  // null inherits that current value; manual edits (including clearing) and
  // explicit template/print choices own the Rx draft across cancellation/reopening.
  const [diagnosisOverride, setDiagnosisOverride] = useState<string | null>(null);
  const diagnosis = diagnosisOverride ?? defaultDiagnosis;
  const session = useSession();
  const prescriberKey = JSON.stringify([isOpen, patientId, visitId, session?.username, session?.role, session?.permissions]);
  type PrescriberOptions = { issuerId: number; canChooseAnyDoctor: boolean; doctors: { id: number; name: string }[] };
  const [prescriberRead, setPrescriberRead] = useState<{ key: string; status: "loading" | "error" | "ready"; options: PrescriberOptions | null; unavailableMessage?: string } | null>(null);
  const [prescriberRetry, setPrescriberRetry] = useState(0);
  const prescriberStatus = prescriberRead?.key === prescriberKey ? prescriberRead.status : "loading";
  const prescriberOptions = prescriberStatus === "ready" ? prescriberRead?.options ?? null : null;
  const [override, setOverride] = useState<{ key: string; id: number | null } | null>(null);
  const setPrescriberOverride = (id: number | null) => setOverride({ key: prescriberKey, id });
  const preferredDoctorId = (override?.key === prescriberKey ? override.id : null) ?? defaultDoctorPartyId;
  const selectedDoctorId = preferredDoctorId ?? prescriberOptions?.issuerId ?? null;
  const doctorName = !prescriberOptions ? "" : prescriberOptions.doctors.find(d => d.id === selectedDoctorId)?.name
    ?? (selectedDoctorId === defaultDoctorPartyId ? defaultDoctorName : "");
  const prescriberMismatch = Boolean(prescriberOptions && !prescriberOptions.canChooseAnyDoctor
    && selectedDoctorId !== null && selectedDoctorId !== prescriberOptions.issuerId);

  const [notes, setNotes] = useState("");
  const [lang, setLang] = useState<InstructionsLang>("both");
  /* تبدأ فارغة: القالب اختيارٌ صريح لا حالة افتراضية (P0.10) — فتحُ المودال
     محمّلًا بمضادٍ حيوي جعل ضغطة طباعةٍ واحدة وصفةً لم تُراجَع. */
  const [items, setItems] = useState<RxItem[]>(() => [blankPrescriptionRow()]);
  /* قائمة التحقق السريري للقالب المطبّق (مراجعة الجولة الثانية): تُعرض للطبيب
   * قبل الوصف — القالب عبّأ الحالة فقط، والدواء قراره هو. */
  const [appliedChecklist, setAppliedChecklist] = useState<string[] | null>(null);
  /* الوصفة وثيقة تُحفى كُما طُبِعت (من مستودع الوكيل الآخر): الحفظ قبل الطباعة
     يبقي في السجل ما صدر من وصفة، دون ادعاء صرف الصيدلية، والاقتراحات مما سبق وصفه للمريض
     نفسه تقلّل النقر — ولا تُفرض. */
  const commandScope = session?.username && patientId ? prescriptionCommandStorageKey(session.username, patientId, visitId ?? null) : null;
  const operationScope = isOpen ? JSON.stringify([commandScope, prescriberKey, selectedDoctorId]) : null;
  const operationFence = useRef(createPrescriptionOperationFence());
  const [blockedSavedPrintId, setBlockedSavedPrintId] = useState<number | null>(null);
  const [preservingScope, setPreservingScope] = useState<string | null>(null);
  const preserving = operationScope !== null && preservingScope === operationScope;
  const setPreserving = (value: boolean) => setPreservingScope(value ? operationScope : null);
  const [commandRead, setCommandRead] = useState<{ scope: string; owner: string | null; entry: PendingPrescriptionCommand | null; message: string; recoveredId?: number; status?: string } | null>(null);
  useLayoutEffect(() => {
    const fence = operationFence.current;
    fence.setScope(operationScope);
    setPreservingScope(null);
    setBlockedSavedPrintId(null);
    return () => { fence.retire(); setCommandRead(null); };
  }, [operationScope]);

  const commandState = commandRead?.scope === commandScope && commandRead?.owner === operationScope ? commandRead : null;
  useEffect(() => {
    if (!isOpen || !commandScope) return;
    try {
      const entry = readPrescriptionCommand(window.sessionStorage, commandScope);
      if (entry) setCommandRead({ scope: commandScope, owner: operationScope, entry, message: "يوجد مفتاح إصدار سابق محفوظ في هذه الصفحة. تحقق من النتيجة قبل بدء وصفة جديدة." });
    } catch { setCommandRead({ scope: commandScope, owner: operationScope, entry: null, message: "تعذرت قراءة مفتاح الإصدار السابق؛ راجع السجل قبل بدء وصفة جديدة." }); }
  }, [isOpen, commandScope, operationScope]);

  const [preserveError, setPreserveError] = useState<string | null>(null);
  /* مراجعة الجولة الثانية (Blocker B) — الخادم هو المرجع: */
  /* عرض تحذيرات الخادم غير الحرجة قبل الحفظ، مع رمز الإقرار المرتبط بالوصفة. */
  const [safetyPreview, setSafetyPreview] = useState<{
    warnings: DrugSafetyAlert[];
    token: string;
    /* سبب إعادة العرض إن تغيّرت التحذيرات بعد إقرار سابق (الجولة الثالثة). */
    notice: string | null;
  } | null>(null);
  /* منعٌ حرج من الخادم (409): توقّف تام — لا رسمية ولا مسودة تلقائية. */
  const [criticalBlock, setCriticalBlock] = useState<{
    message: string;
    alerts: DrugSafetyAlert[];
  } | null>(null);
  /* رسالة إبطال الإقرار (تغيّرت الأدوية بعد الإقرار). */
  const [ackInvalidMessage, setAckInvalidMessage] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<{
    name: string; dose: string; frequency: string; duration: string;
    timesPrescribed: number; lastPrescribedAt: string;
  }[]>([]);

  // Options belong to the exact patient/visit/session and each open request.
  // Loading or a failed lookup cannot reuse a previously verified clinician.
  useEffect(() => {
    setPrescriberRead({ key: prescriberKey, status: "loading", options: null });
    setSuggestions([]);
    if (!isOpen) return;
    if (!patientId) { setPrescriberRead({ key: prescriberKey, status: "error", options: null }); return; }
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/patients/${patientId}/prescriptions`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Prescriber lookup refused");
        const payload = await response.json();
        const options = payload?.prescriberOptions;
        if (options?.issuerId === null && options.canChooseAnyDoctor === false
          && Array.isArray(options.doctors) && options.doctors.length === 0) {
          const unavailableMessage = prescriberUnavailableMessage(options.unavailableReason);
          if (unavailableMessage) {
            if (!cancelled) setPrescriberRead({ key: prescriberKey, status: "error", options: null, unavailableMessage });
            return;
          }
        }
        if (!options || !Number.isSafeInteger(options.issuerId) || options.issuerId <= 0
          || typeof options.canChooseAnyDoctor !== "boolean" || !Array.isArray(options.doctors)
          || !options.doctors.some((doctor: { id: number }) => doctor.id === options.issuerId)
          || !options.doctors.every((doctor: { id: number; name: string }) => Number.isSafeInteger(doctor.id) && doctor.id > 0 && typeof doctor.name === "string" && doctor.name.trim()))
          throw new Error("Missing verified clinician");
        if (!cancelled) {
          setSuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
          setPrescriberRead({ key: prescriberKey, status: "ready", options });
        }
      } catch {
        if (!cancelled) setPrescriberRead({ key: prescriberKey, status: "error", options: null });
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [isOpen, patientId, prescriberKey, prescriberRetry]);

  const safetyAlerts = useMemo(() => {
    return evaluatePrescriptionSafety(items, medicalAlert);
  }, [items, medicalAlert]);

  const hasCriticalAlert = safetyAlerts.some((a) => a.severity === "critical");

  if (!isOpen) return null;

  const applyTemplate = (index: number) => {
    /* قوالب الإجراءات والتشخيصات (مراجعة الجولة الثانية): تُعبّئ التشخيص
     * والملاحظات الإجرائية فقط — لا دواء ولا جرعة. الأدوية يكتبها الطبيب
     * بنفسه (أو يختارها مما وُصف له سابقًا)، ومع القائمة قائمة تحقق سريري. */
    const t = PROCEDURE_TEMPLATES[index];
    if (t) {
      setDiagnosisOverride(t.diagnosis);
      setNotes(t.notes);
      setAppliedChecklist(t.contextChecklist);
    }
  };

  const addItem = () => {
    setItems(previous => previous.length < MAX_ITEMS ? [...previous, blankPrescriptionRow()] : previous);
  };

  const updateItem = (index: number, field: Exclude<keyof RxItem, "selection">, value: string) => {
    setItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value, ...(next[index].selection ? { selection: changedMedicationSelection(next[index].selection!) } : {}) };
      return next;
    });
  };

  const removeItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const validatePrintableItems = () => {
    if (items.length > MAX_ITEMS) { setPreserveError("الحد الأقصى 20 دواءً؛ احذف السطور الزائدة."); return false; }
    if (prescriberMismatch) {
      setPreserveError("طبيب الزيارة يختلف عن هويتك السريرية؛ اختر الإصدار باسمك صراحة قبل المتابعة.");
      return false;
    }
    if (sanitizeRxItems(items).length === 0) {
      setPreserveError("أضف دواءً واحدًا على الأقل باسم مكتوب بالإنجليزية قبل طباعة الوصفة أو معاينة المسودة.");
      return false;
    }
    const selectionError = manualMedicationSelectionError(items);
    if (selectionError) { setPreserveError(selectionError); return false; }
    if (prescriberStatus !== "ready" || !prescriberOptions) {
      setPreserveError("لم يكتمل التحقق من هوية الطبيب؛ انتظر أو أعد المحاولة.");
      return false;
    }
    return true;
  };

  /** إرسال الوصفة إلى الخادم — برمز إقرارٍ إن كان الطبيب أقرّ التحذيرات. */
  const submitToServer = async (operation: PrescriptionOperation, acknowledgedSafetyToken?: string) => {
    if (!commandScope || !patientId || !selectedDoctorId) throw new Error("لم يكتمل سياق الإصدار.");
    const checked = checkPrescriptionDraft({ patientId, visitId: visitId ?? null, prescribingDoctorPartyId: selectedDoctorId, diagnosis, notes, instructionsLang: lang, items });
    if (!checked.ok) throw new Error(checked.message);
    const bytes = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalPrescriptionCommand(checked.value)));
    if (!operationFence.current.current(operation)) return null;
    const digest = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
    const entry = getOrCreatePrescriptionCommand(window.sessionStorage, commandScope, digest, selectedDoctorId, () => window.crypto.randomUUID());
    setCommandRead({ scope: commandScope, owner: operationScope, entry, message: "مفتاح الإصدار محفوظ. عند تعذر الاتصال أعد المحاولة بالمفتاح نفسه." });
    const response = await fetch("/api/prescriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandKey: entry.key,
        patientId,
        ...(visitId ? { visitId } : {}),
        ...(selectedDoctorId ? { prescribingDoctorPartyId: selectedDoctorId } : {}),
        diagnosis,
        notes,
        instructionsLang: lang,
        items,
        ...(acknowledgedSafetyToken ? { acknowledgedSafetyToken } : {}),
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!operationFence.current.current(operation)) return null;
    const outcome = interpretPrescriptionSaveResponse(response.status, payload);
    if (outcome.kind === "officialPrint" || outcome.kind === "recoveredIssuance") setCommandRead({ scope: commandScope, owner: operationScope, entry, recoveredId: outcome.prescriptionId, status: "active", message: "الإصدار محفوظ؛ تكرار الطلب يعيد الوصفة نفسها ولا ينشئ وصفة أخرى." });
    return outcome;
  };

  const recoverIssuance = async () => {
    if (!commandScope || !patientId) return;
    const operation = operationFence.current.start();
    if (!operation) return;
    setPreserving(true);
    try {
      const entry = readPrescriptionCommand(window.sessionStorage, commandScope);
      if (!entry) throw new Error("لا يوجد مفتاح إصدار محفوظ في هذه الصفحة.");
      const query = new URLSearchParams({ patientId: String(patientId), prescribingDoctorPartyId: String(entry.prescribingDoctorPartyId) });
      if (visitId) query.set("visitId", String(visitId));
      const response = await fetch(`/api/prescriptions/commands/${entry.key}?${query}`, { cache: "no-store" });
      const body = await response.json();
      if (!operationFence.current.current(operation)) return;
      if (!response.ok || body.state !== "completed" || !Number.isSafeInteger(body.id) || body.id <= 0 || !["active", "void"].includes(body.status)) {
        setCommandRead({ scope: commandScope, owner: operationScope, entry, message: body.message || "لم تتأكد النتيجة؛ احتفظ بالمفتاح ولا تبدأ إصدارًا جديدًا." });
        return;
      }
      setCommandRead({ scope: commandScope, owner: operationScope, entry, recoveredId: body.id, status: body.status,
        message: body.status === "void" ? "الإصدار السابق محفوظ لكنه مبطل؛ لا تعاد طباعته." : "تم العثور على الإصدار المحفوظ. لم تُنشأ وصفة جديدة ولم تبدأ الطباعة تلقائيًا." });
    } catch (error) { if (operationFence.current.current(operation)) setPreserveError(error instanceof Error ? error.message : "تعذر التحقق من نتيجة الإصدار؛ احتفظ بالمفتاح."); }
    finally { if (operationFence.current.current(operation)) setPreserving(false); operationFence.current.finish(operation); }
  };
  const startNewIssuance = () => {
    if (!commandScope || preserving || operationFence.current.isBusy()) return;
    if (!window.confirm("قد تكون الوصفة السابقة صدرت حتى لو انقطع الرد. راجع سجل المريض أولًا. هل تريد صراحةً بدء إصدار جديد بمفتاح مستقل؟ لا يحذف هذا الإجراء أي وصفة محفوظة.")) return;
    try { window.sessionStorage.removeItem(commandScope); setCommandRead(null); setPreserveError(null); setSafetyPreview(null); }
    catch { setPreserveError("تعذر تحديث مفتاح الإصدار؛ لم تبدأ وصفة جديدة."); }
  };

  const openOfficialPrint = (prescriptionId: number) => {
    /* الوثيقة الرسمية تُطبع من المحفوظ: اسم الطبيب من snapshot السجل
     * لا من الرابط — فلا وثيقة رسمية تحمل اسمًا مزوّرًا (P0.9). */
    if (!patientId) return;
    const opening = openSavedPrescriptionPrint(patientId, prescriptionId, (url, target) => window.open(url, target));
    if (opening && !opening.opened) {
      setBlockedSavedPrintId(prescriptionId);
    }
  };

  const handlePrint = async () => {
    if (!validatePrintableItems()) return;
    const operation = operationFence.current.start();
    if (!operation) return;
    // Printing claims this diagnosis for the prescription being submitted.
    // Later visit-note updates cannot silently change its display or the
    // canonical content while save/safety acknowledgement is in progress.
    setDiagnosisOverride(diagnosis);
    /* الوصفة وثيقة: تُحفَظ أوّلًا ثم تُطبَع من المحفوظ. والخادم هو المرجع
     * النهائي للسلامة (مراجعة الجولة الثانية — Blocker B):
     * - تعارضٌ حرج (409) ⇒ توقّف تام: لا طباعة رسمية ولا سقوط تلقائي إلى
     *   مسودة؛ يُعرض سبب المنع، والمسودة تُراجع داخل النافذة فقط.
     * - تحذيرات غير حرجة ⇒ عرضٌ وإقرارٌ صريح قبل الحفظ والطباعة الرسمية.
     * - فشل الشبكة/500 قد يخفي إصدارًا ناجحًا: لا طباعة تلقائية ولا مفتاح جديد. */
    setCriticalBlock(null);
    setSafetyPreview(null);
    setAckInvalidMessage(null);
    if (patientId) {
      setPreserving(true);
      setPreserveError(null);
      try {
        const outcome = await submitToServer(operation);
        if (!outcome || !operationFence.current.current(operation)) return;
        if (outcome.kind === "recoveredIssuance") return;
        if (outcome.kind === "officialPrint") {
          openOfficialPrint(outcome.prescriptionId);
          return;
        }
        if (outcome.kind === "criticalBlock") {
          /* منعٌ حرج: توقّف تام — لا window.open إطلاقًا من هذا المسار. */
          setCriticalBlock({ message: outcome.message, alerts: outcome.safetyAlerts });
          return;
        }
        if (outcome.kind === "awaitAcknowledgement") {
          /* لا حفظ ولا طباعة بعد: عرض التحذيرات على الطبيب أولاً. */
          setSafetyPreview({
            warnings: outcome.safetyWarnings,
            token: outcome.acknowledgementToken,
            notice: outcome.message ?? null,
          });
          return;
        }
        if (outcome.kind === "acknowledgementRejected") {
          setAckInvalidMessage(outcome.message);
          return;
        }
        if (outcome.kind === "issuanceBlocked") { setPreserveError(outcome.message); return; }
        setPreserveError(outcome.reason);
        return;
      } catch (error) {
        if (!operationFence.current.current(operation)) return;
        setPreserveError(error instanceof Error ? error.message : "لم تتأكد نتيجة الإصدار؛ أعد المحاولة بالمفتاح نفسه أو تحقق من السجل.");
        return;
      } finally {
        if (operationFence.current.current(operation)) setPreserving(false);
        operationFence.current.finish(operation);
      }
    }
    if (operationFence.current.current(operation)) setPreserveError("الطباعة متاحة من النسخة المحفوظة فقط؛ أكمل سياق المريض والطبيب واحفظ الوصفة أولًا.");
    operationFence.current.finish(operation);
  };

  /** إقرار الطبيب قراءة التحذيرات غير الحرجة ثم الحفظ والطباعة الرسمية —
   * يُعاد إرسال نفس الوصفة مع رمز الإقرار؛ فإن تغيّرت الأدوية بعد الإقرار
   * رفضه الخادم وأُعيد العرض. */
  const handleAcknowledgeAndPrint = async () => {
    if (!safetyPreview?.token || !patientId) return;
    if (!validatePrintableItems()) return;
    const operation = operationFence.current.start();
    if (!operation) return;
    setPreserving(true);
    setAckInvalidMessage(null);
    try {
      const outcome = await submitToServer(operation, safetyPreview.token);
      if (!outcome || !operationFence.current.current(operation)) return;
      if (outcome.kind === "recoveredIssuance") { setSafetyPreview(null); return; }
      if (outcome.kind === "officialPrint") {
        setSafetyPreview(null);
        openOfficialPrint(outcome.prescriptionId);
        return;
      }
      if (outcome.kind === "criticalBlock") {
        /* تحوّل الحالة إلى حرج بين المعاينة والإقرار (ملف المريض تغيّر): توقّف تام. */
        setSafetyPreview(null);
        setCriticalBlock({ message: outcome.message, alerts: outcome.safetyAlerts });
        return;
      }
      if (outcome.kind === "acknowledgementRejected") {
        setSafetyPreview(null);
        setAckInvalidMessage(outcome.message);
        return;
      }
      if (outcome.kind === "awaitAcknowledgement") {
        /* رجع الخادم بعرض تحذيرات جديدة/محدثة بعد الإقرار — يُعرض من جديد. */
        setSafetyPreview({
          warnings: outcome.safetyWarnings,
          token: outcome.acknowledgementToken,
          notice: outcome.message ?? null,
        });
        return;
      }
      setSafetyPreview(null);
      if (outcome.kind === "issuanceBlocked") { setPreserveError(outcome.message); return; }
      setPreserveError(outcome.reason);
    } catch (error) {
      if (!operationFence.current.current(operation)) return;
      setAckInvalidMessage(error instanceof Error ? error.message : "لم تتأكد نتيجة الإصدار؛ أعد المحاولة بالمفتاح نفسه أو تحقق من السجل.");
    } finally {
      if (operationFence.current.current(operation)) setPreserving(false);
      operationFence.current.finish(operation);
    }
  };

  // Sharing unsaved editable rows could bypass server safety and put clinical
  // data in an external URL. Keep this explicitly unavailable until a separate
  // active-saved-record, recipient and content review workflow is implemented.
  const handleWhatsApp = () => setPreserveError("مشاركة واتساب غير متاحة حاليًا؛ يلزم مسار مستقل يراجع الوصفة المحفوظة النشطة والمستلم والمحتوى قبل المشاركة. لم تُفتح خدمة خارجية.");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div
        className="fixed inset-0"
        onClick={onClose}
      />
      <div className="relative z-10 flex flex-col max-h-[90vh] w-full max-w-3xl rounded-3xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
        {/* رأس النافذة */}
        <div className="shrink-0 flex items-center justify-between border-b border-slate-100 bg-slate-50/80 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-navy text-white text-lg font-serif font-black shadow-xs">
              ℞
            </div>
            <div>
              <h2 className="text-base font-black text-navy-900">
                إصدار وصفة طبية (روشتة)
              </h2>
              <p className="text-xs text-slate-500 font-medium">
                المريض: <strong className="text-navy-800">{patientName}</strong>
                 · <span dir="ltr">Drug names in English</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-slate-400 hover:bg-slate-200 hover:text-slate-700 transition-colors"
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>

        {/* محتوى النموذج */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
          {patientContextStatus && patientContextStatus !== "ready" && (
            <p role="status" className="rounded-2xl border border-amber-300 bg-amber-50 p-3.5 text-xs font-semibold text-amber-950">
              {patientContextStatus === "loading"
                ? "جارٍ تحميل التنبيهات الطبية وبيانات التواصل من ملف المريض. عدم ظهور تنبيه الآن لا يعني عدم وجود حساسية أو مخاطر دوائية."
                : "تعذّر التحقق من التنبيهات الطبية وبيانات التواصل من ملف المريض. حالة الحساسية والمخاطر غير معروفة هنا؛ تحقّق من الملف قبل الوصف، وأعد فتح النافذة للمحاولة مجددًا."}
            </p>
          )}
          {/* تنبيه الحساسية إن وُجد */}
          {medicalAlert && (
            <div className="flex items-center gap-2.5 rounded-2xl border border-red-200 bg-red-50/80 p-3.5 text-xs text-red-900">
              <span className="text-base">⚠️</span>
              <div>
                <strong className="font-bold">تنبيه طبي وحساسية للمريض: </strong>
                <span>{medicalAlert}</span>
              </div>
            </div>
          )}

          {/* فحص الأمان الدوائي والتعارضات السريرية */}
          {safetyAlerts.length > 0 && (
            <div className="space-y-2.5 rounded-2xl border border-red-300 bg-red-50/90 p-4 shadow-xs">
              <div className="flex items-center justify-between text-xs font-black text-red-900">
                <div className="flex items-center gap-2">
                  <span className="text-base">🛡️</span>
                  <span>فحص الأمان الدوائي — تم رصد ({safetyAlerts.length}) تعارض سريري محتمل:</span>
                </div>
                {hasCriticalAlert && (
                  <span className="rounded-full bg-red-600 px-2.5 py-0.5 text-[10px] font-extrabold text-white">
                    خطر حرج
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {safetyAlerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={`rounded-xl border p-3 text-xs ${
                      alert.severity === "critical"
                        ? "border-red-400 bg-white text-red-950"
                        : "border-amber-400 bg-white text-amber-950"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5 font-bold">
                        <span>{alert.severity === "critical" ? "⛔" : "⚠️"}</span>
                        <span>{alert.title}</span>
                      </div>
                      <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-mono font-bold text-slate-700">
                        {alert.medicationName}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-700">
                      {alert.message}
                    </p>
                    {alert.suggestedAlternative && (
                      <div className="mt-2 rounded-lg bg-emerald-50 border border-emerald-200 p-2 text-[11px] text-emerald-900 font-semibold">
                        💡 {alert.suggestedAlternative}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* قائمة التحقق السريري للقالب المطبّق: «لا تنبيه مسجل ≠ مريض سليم». */}
          {appliedChecklist && (
            <div className="rounded-2xl border border-amber-300 bg-amber-50/80 p-4 text-xs text-amber-950">
              <div className="flex items-center gap-2 font-black">
                <span className="text-base">🩺</span>
                <span>قبل وصف أي دواء لهذه الحالة — تحقّق سريريًا من:</span>
              </div>
              <ul className="mt-2 space-y-1.5 pr-4">
                {appliedChecklist.map((point) => (
                  <li key={point} className="list-disc text-[11px] leading-relaxed">{point}</li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] font-bold text-amber-800">
                غياب التنبيه المسجل في الملف لا يعني مريضًا سليمًا — تحقّق وسجّل ما يلزم.
              </p>
            </div>
          )}

          {commandState && <div className="rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm" role="status">
            <p>{commandState.message}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {commandState.entry && <button type="button" disabled={preserving} onClick={() => void recoverIssuance()} className="rounded border bg-white px-3 py-2">التحقق من نتيجة الإصدار السابق</button>}
              {commandState.recoveredId && commandState.status === "active" && <a href={`/print/prescription/${patientId}?rx=${commandState.recoveredId}`} target="_blank" rel="noopener noreferrer" className="rounded border border-slate-900 bg-slate-900 px-3 py-2 font-bold text-white">فتح النسخة المحفوظة #{commandState.recoveredId}</a>}
              <button type="button" disabled={preserving} onClick={startNewIssuance} className="rounded border bg-white px-3 py-2">بدء إصدار جديد بعد مراجعة السجل</button>
            </div>
          </div>}
          {preserveError ? (
            <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
              {preserveError}
            </p>
          ) : null}

          {/* منعٌ حرج من الخادم (409): توقّف تام — لا طباعة رسمية ولا مسودة
              تلقائية؛ سبب المنع ظاهر، والمسودة تُراجع داخل النافذة دون رابط طباعة. */}
          {criticalBlock && (
            <div className="space-y-2.5 rounded-2xl border-2 border-red-500 bg-red-50 p-4 shadow-xs">
              <div className="flex items-center gap-2 text-xs font-black text-red-900">
                <span className="text-base">⛔</span>
                <span>منع حفظ وطباعة رسمية — تعارض دوائي حرج وفق ملف المريض:</span>
              </div>
              <p className="text-[11px] font-bold leading-relaxed text-red-800">{criticalBlock.message}</p>
              <div className="space-y-2">
                {criticalBlock.alerts.map((alert) => (
                  <div key={alert.id} className="rounded-xl border border-red-300 bg-white p-3 text-xs text-red-950">
                    <div className="flex items-center justify-between gap-2 font-bold">
                      <span>{alert.title}</span>
                      <span className="rounded-md bg-red-100 px-2 py-0.5 text-[10px] font-mono text-red-800">{alert.medicationName}</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-700">{alert.message}</p>
                  </div>
                ))}
              </div>
              <p className="text-[11px] font-bold text-red-700">
                صحّح التعارض (بديلٌ يقرره الطبيب أو تحديث الملف) ثم أعد المحاولة — لا تُصرف وصفة رسمية بهذا التعارض.
              </p>
              <button
                type="button"
                onClick={() => setPreserveError("المسودة للمراجعة داخل هذه النافذة فقط؛ الطباعة متاحة بعد حفظ وصفة معتمدة. صحّح سبب المنع قبل الحفظ، وستبقى جميع الحقول كما كتبتها.")}
                className="rounded-xl border border-red-300 bg-white px-4 py-2 text-xs font-bold text-red-700 hover:bg-red-100 transition-colors"
              >
                مراجعة المسودة داخل النافذة
              </button>
            </div>
          )}

          {/* عرض تحذيرات الخادم غير الحرجة قبل الحفظ: لا طباعة رسمية إلا بعد
              إقرار الطبيب الصريح — والإقرار مرتبط بالوصفة نفسها (رمز خادمي). */}
          {safetyPreview && (
            <div className="space-y-2.5 rounded-2xl border-2 border-amber-400 bg-amber-50/90 p-4 shadow-xs">
              <div className="flex items-center gap-2 text-xs font-black text-amber-950">
                <span className="text-base">⚠️</span>
                <span>تحذيرات سلامة دوائية من الخادم — إقرارك مطلوب قبل الحفظ والطباعة الرسمية:</span>
              </div>
              <div className="space-y-2">
                {safetyPreview.notice ? (
                  <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-[11px] font-bold text-red-800">
                    {safetyPreview.notice}
                  </p>
                ) : null}
                {safetyPreview.warnings.map((alert) => (
                  <div key={alert.id} className="rounded-xl border border-amber-300 bg-white p-3 text-xs text-amber-950">
                    <div className="flex items-center justify-between gap-2 font-bold">
                      <span>{alert.title}</span>
                      <span className="rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-mono text-amber-900">{alert.medicationName}</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-700">{alert.message}</p>
                    {alert.suggestedAlternative && (
                      <p className="mt-1.5 text-[11px] font-semibold text-emerald-800">💡 {alert.suggestedAlternative}</p>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void handleAcknowledgeAndPrint()}
                  disabled={preserving || prescriberStatus !== "ready"}
                  className="rounded-xl bg-amber-600 px-4 py-2 text-xs font-black text-white shadow-xs hover:bg-amber-700 transition-all disabled:opacity-50"
                >
                  {preserving ? "جارٍ الحفظ بعد الإقرار…" : "أقرّ قراءة التحذيرات — حفظ الوصفة وطباعتها رسميًا"}
                </button>
                <button
                  type="button"
                  onClick={() => setSafetyPreview(null)}
                  className="rounded-xl border border-amber-300 bg-white px-4 py-2 text-xs font-bold text-amber-800 hover:bg-amber-100"
                >
                  رجوع للتعديل (تغيير الأدوية يُبطل هذا الإقرار)
                </button>
              </div>
              <p className="text-[11px] font-semibold text-amber-800">
                الإقرار مرتبط بهذه الأدوية تحديدًا وبالتحذيرات المعروضة الآن، وصالح عشر دقائق: أي تغيير دوائي أو تحذيري بعد الإقرار — أو تجاوز المهلة — يرفضه الخادم ويعيد العرض.
              </p>
            </div>
          )}

          {ackInvalidMessage ? (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-bold text-red-800">
              {ackInvalidMessage}
            </p>
          ) : null}

          {/* تفاصيل الطبيب والتشخيص */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                التشخيص الطبي
              </label>
              <input
                type="text"
                value={diagnosis}
                onChange={(e) => setDiagnosisOverride(e.target.value)}
                placeholder="مثال: Acute Pulpitis / Post-Extraction"
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-xs focus:border-brand-navy focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                الطبيب الواصف
              </label>
              {prescriberOptions?.canChooseAnyDoctor ? (
                <select aria-label="الطبيب الواصف" value={selectedDoctorId ?? ""}
                  onChange={event => setPrescriberOverride(Number(event.target.value))}
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-xs">
                  {prescriberOptions.doctors.map(doctor => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
                </select>
              ) : (
                <input aria-label="الطبيب الواصف" type="text" value={doctorName} readOnly
                  placeholder="الاسم من الهوية السريرية للحساب"
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-xs" />
              )}
            </div>
          </div>

          {prescriberStatus === "loading" && <p role="status" className="text-sm">جارٍ التحقق من هوية الطبيب الواصف…</p>}
          {prescriberStatus === "error" && <div role="alert" className="rounded border border-red-200 p-3 text-sm">
            <p>{prescriberRead?.key === prescriberKey && prescriberRead.unavailableMessage
              ? prescriberRead.unavailableMessage : "تعذر التحقق من هوية الطبيب الواصف."} الإصدار والمعاينة متوقفان حتى ينجح التحقق.</p>
            <button type="button" onClick={() => setPrescriberRetry(value => value + 1)} className="mt-2 rounded border px-3 py-2">إعادة التحقق من الطبيب</button>
          </div>}
          {session?.role === "admin" && !prescriberOptions?.canChooseAnyDoctor && <p role="status" className="rounded border border-amber-200 p-3 text-xs">
            اختيار طبيب آخر للمالك غير متاح حاليًا؛ لم يكتمل ربط صلاحية المالك. الإصدار الحالي باسم طبيب الحساب فقط بعد التحقق منه.
          </p>}
          {prescriberMismatch && <div role="alert" className="rounded border border-amber-300 bg-amber-50 p-3 text-xs">
            <p>الطبيب المحدد في الزيارة يختلف عن الطبيب المرتبط بحسابك. لم نغيّر الاختيار تلقائيًا.</p>
            <button type="button" onClick={() => setPrescriberOverride(prescriberOptions?.issuerId ?? null)} className="mt-2 rounded border px-3 py-2">
              إصدار باسمي: {prescriberOptions?.doctors.find(d => d.id === prescriberOptions.issuerId)?.name}
            </button>
          </div>}

          {/* قائمة الأدوية */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold text-slate-700">
                💊 قائمة الأدوية والجرعات ({items.length}) — <span dir="ltr" className="font-extrabold">English</span>:
              </label>
              <button
                type="button"
                onClick={addItem}
                disabled={items.length >= MAX_ITEMS}
                className="flex items-center gap-1 text-xs font-bold text-brand-navy hover:text-navy-700"
              >
                <Icon name="plus" className="h-3.5 w-3.5" />
                <span>إضافة دواء جديد</span>
              </button>
            </div>

            <div className="space-y-3">
              {items.map((item, idx) => {
                const itemAlert = safetyAlerts.find(
                  (a) => a.medicationName.trim().toLowerCase() === item.name.trim().toLowerCase()
                );
                return (
                  <div
                    key={idx}
                    className={`rounded-2xl border p-3.5 space-y-2.5 transition-all ${
                      itemAlert?.severity === "critical"
                        ? "border-red-400 bg-red-50/40 ring-1 ring-red-400/50"
                        : itemAlert?.severity === "warning"
                        ? "border-amber-400 bg-amber-50/40 ring-1 ring-amber-400/50"
                        : "border-slate-200 bg-slate-50/60"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-slate-700">
                        {idx + 1}
                      </span>
                      <input
                        type="text"
                        value={item.name}
                        onChange={(e) => updateItem(idx, "name", e.target.value)}
                        placeholder="Drug name"
                        aria-label={`اسم الدواء للسطر ${idx + 1}`}
                        dir="ltr"
                        className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-navy-900 focus:border-brand-navy focus:outline-none"
                      />
                      <label className="order-last w-full text-[11px] text-slate-700 sm:order-none sm:w-36">القوة / التركيز والوحدة
                      <input
                        type="text"
                        value={item.dose}
                        onChange={(e) => updateItem(idx, "dose", e.target.value)}
                        placeholder="Strength / concentration + unit"
                        aria-label={`التركيز أو القوة والوحدة للسطر ${idx + 1}`}
                        dir="ltr"
                        className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs focus:border-brand-navy focus:outline-none"
                      />
                      </label>
                      <button
                        type="button"
                        onClick={() => removeItem(idx)}
                        className="text-slate-400 hover:text-red-600 p-1"
                        title="حذف الدواء"
                      >
                        <Icon name="trash" className="h-4 w-4" />
                      </button>
                    </div>

                    {itemAlert && (
                      <div className="flex items-center gap-1.5 text-[11px] font-bold text-red-700 bg-red-100/70 px-2.5 py-1 rounded-lg">
                        <span>{itemAlert.severity === "critical" ? "⛔" : "⚠️"}</span>
                        <span>{itemAlert.title}: {itemAlert.message}</span>
                      </div>
                    )}

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs" dir="ltr">
                    <input
                      type="text"
                      value={item.form}
                      onChange={(e) => updateItem(idx, "form", e.target.value)}
                      placeholder="Form / route (tablet, oral rinse…)"
                      className="rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 focus:border-brand-navy focus:outline-none"
                    />
                    <input
                      type="text"
                      value={item.frequency}
                      onChange={(e) => updateItem(idx, "frequency", e.target.value)}
                      placeholder="Frequency (every 8 hours)"
                      className="rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 focus:border-brand-navy focus:outline-none"
                    />
                    <input
                      type="text"
                      value={item.duration}
                      onChange={(e) => updateItem(idx, "duration", e.target.value)}
                      placeholder="Duration (5 days)"
                      className="rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 focus:border-brand-navy focus:outline-none"
                    />
                  </div>

                  <PrescriptionStaleReferenceNotice item={item} onRetire={() => setItems(previous => retireDraftDoseReferenceAt(previous, idx, item))}/>

                  {item.selection && <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs">
                    <p>{item.selection.doseReview?.mode === "calculated" ? "نُقلت النتيجة من حساب مرجعي متحقق رياضيًا؛ راجعها سريريًا قبل الإصدار. أي تعديل يدوي يزيل وصف الحساب." : item.selection.doseReview ? "تعديل يدوي مرتبط بمصدر مرجعي فقط — ليس نتيجة حساب معتمدة؛ أعد مراجعة السطر." : "أكمل الشكل والتركيز ومقدار الجرعة والتكرار والمدة بنفسك؛ لا اعتماد تلقائي."}</p>
                    <label className="my-2 block">مقدار الجرعة ووحدتها لكل مرة
                      <input aria-label={`مقدار الجرعة للسطر ${idx + 1}`} dir="ltr" value={item.selection.amount} placeholder="Clinician-entered amount per dose"
                        onChange={event => setItems(previous => previous.map((row, i) => i === idx && row.selection ? { ...row, selection: { ...changedMedicationSelection(row.selection), amount: event.target.value } } : row))}
                        className="mx-2 rounded border bg-white p-2" />
                    </label>
                    <label className="flex gap-2"><input type="checkbox" checked={item.selection.confirmed}
                      onChange={event => setItems(previous => previous.map((row, i) => i === idx && row.selection ? { ...row, selection: { ...row.selection, confirmed: event.target.checked } } : row))} />
                      راجعت الاستطباب والحساسية والشكل والتركيز والجرعة والتكرار والمدة لهذا السطر. هذا لا يلغي تنبيهات السلامة.
                    </label>
                  </div>}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    <input
                      type="text"
                      value={item.instructions}
                      onChange={(e) => updateItem(idx, "instructions", e.target.value)}
                      placeholder="التعليمات بالعربية (بعد الأكل…)"
                      className="rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 focus:border-brand-navy focus:outline-none"
                    />
                    <input
                      type="text"
                      value={item.instructionsEn}
                      onChange={(e) => updateItem(idx, "instructionsEn", e.target.value)}
                      placeholder="Instructions in English (after meals…)"
                      dir="ltr"
                      className="rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 focus:border-brand-navy focus:outline-none"
                    />
                  </div>
                </div>
              );
            })}
          </div>
          </div>

          {/* لغة التعليمات */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-2">
              🌐 لغة تعليمات المريض على الروشتة:
            </label>
            <div className="inline-flex gap-1 rounded-xl bg-slate-100 p-1">
              {LANG_LABELS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setLang(key)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-black transition-colors ${
                    lang === key ? "bg-white text-navy-900 shadow-xs" : "text-slate-500 hover:text-navy-800"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] font-semibold text-slate-400">
              أسماء الأدوية والجرعات تُطبع بالإنجليزية دائمًا — التعليمات للمريض بلغته.
            </p>
          </div>

          <details data-prescription-optional="history" className="rounded-xl border border-slate-200 p-3">
            <summary className="cursor-pointer text-sm font-bold">أدوية وُصفت سابقًا (اختياري)</summary>
          {/*
            * مما سبق وصفه لهذا المريض (من مستودع الوكيل الآخر): رقائقٌ تُقلّل
            * النقر ولا تُفرض — التكرار الإداري المريح ليس قرارًا سريريًّا.
            */}
          {prescriberStatus === "ready" && suggestions.length > 0 ? (
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-2">
                ↩️ وُصف له سابقًا (اضغط لإضافته إلى القائمة):
              </label>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion.name}
                    type="button"
                    disabled={!canAcceptPrescriptionSelection(items)}
                    title={`وُصف ${suggestion.timesPrescribed} مرة — آخرها ${new Date(suggestion.lastPrescribedAt).toLocaleDateString("ar")}`}
                    onClick={() => setItems((prev) => appendPrescriptionSelection(prev, {
                        selection: { id: "manual", amount: "", confirmed: false },
                        name: suggestion.name,
                        dose: suggestion.dose,
                        form: "",
                        frequency: suggestion.frequency,
                        duration: suggestion.duration,
                        instructions: "",
                        instructionsEn: "",
                      }))}
                    className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-800 hover:border-sky-400 hover:bg-sky-100 transition-all"
                    dir="ltr"
                  >
                    {suggestion.name}
                    {suggestion.timesPrescribed > 1 ? ` ×${suggestion.timesPrescribed}` : ""}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          </details>
          <details data-prescription-optional="references" className="rounded-xl border border-slate-200 p-3">
            <summary className="cursor-pointer text-sm font-bold">اختيار من القوالب والمراجع (اختياري)</summary>
            <p className="my-2 text-xs"><a href="/settings/medications" target="_blank" rel="noopener noreferrer" className="underline text-blue-800">إدارة قوالب الأدوية في الإعدادات</a> · يفتح في تبويب جديد دون فقد المسودة.</p>
            <div className="space-y-3">
          <PrescriptionDoseProfiles key={`dose:${patientId}:${visitId ?? "none"}:${selectedDoctorId ?? "none"}:${prescriberStatus}`} disabled={!canAcceptPrescriptionSelection(items) || prescriberStatus !== "ready"} onSelect={item => setItems(previous => appendPrescriptionSelection(previous, item))} />
          <PrescriptionClinicCatalog key={`${patientId}:${visitId ?? "none"}:${selectedDoctorId ?? "none"}:${prescriberStatus}`} disabled={!canAcceptPrescriptionSelection(items) || prescriberStatus !== "ready"} onSelect={item => setItems(previous => appendPrescriptionSelection(previous, item))} />
          <PrescriptionMedicationLibrary disabled={!canAcceptPrescriptionSelection(items) || prescriberStatus !== "ready"} onSelectName={id => {
            const item = createManualMedicationSelection(id);
            if (item) setItems(previous => appendPrescriptionSelection(previous, item));
          }} />

            </div>
          </details>
          <details data-prescription-optional="procedures" className="rounded-xl border border-slate-200 p-3">
            <summary className="cursor-pointer text-sm font-bold">قوالب التشخيص والعناية (اختياري)</summary>
          {/* قوالب الإجراءات والتشخيصات — لا أدوية (مراجعة الجولة الثانية):
           * تُعبّئ نوع الحالة والتشخيص والملاحظات الإجرائية فقط؛ اختيار الدواء
           * والجرعة يبقى بيد الطبيب، وتظهر معها قائمة تحقق سريري. */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-2">
              ⚡ قوالب إجراءات وتشخيصات (تُعبّئ الحالة — لا تحتوي أدوية):
            </label>
            <div className="flex flex-wrap gap-2">
              {PROCEDURE_TEMPLATES.map((tmpl, idx) => (
                <button
                  key={idx}
                  type="button"
                  title={`${tmpl.diagnosis} — يُعبّئ التشخيص والعناية الإجرائية؛ الأدوية والجرعات يحددها الطبيب`}
                  onClick={() => applyTemplate(idx)}
                  className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-brand-navy hover:bg-navy-50 hover:text-navy-900 transition-all"
                >
                  {tmpl.title}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] font-semibold text-slate-400">
              القالب لا يختار دواءً ولا جرعة — التقييم الدوائي والأدوية قرارٌ سريري يُكتب يدويًا أو يُختار مما وُصف له سابقًا.
            </p>
          </div>

          </details>

          {/* ملاحظات وإرشادات إضافية */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">
              إرشادات وتعليمات خاصة للمريض
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="مثال: الامتناع عن المشروبات الساخنة لمدة 24 ساعة، وضع كمادات باردة..."
              className="w-full rounded-xl border border-slate-300 p-3 text-xs focus:border-brand-navy focus:outline-none"
            />
          </div>
        </div>

        {/* تذييل النافذة والإجراءات */}
        <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3">
          <p className="w-full text-xs text-slate-600">الطباعة من النسخة المحفوظة فقط. المسودة غير المحفوظة تبقى للمراجعة هنا.</p>
          {blockedSavedPrintId && commandState?.recoveredId === blockedSavedPrintId && commandState.status === "active" && <div role="status" className="flex w-full flex-wrap items-center gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs">
            <span>الوصفة محفوظة ولم تُفتح نافذة الطباعة. افتح النسخة المحفوظة مباشرة؛ لا تبدأ إصدارًا جديدًا.</span>
            <a href={`/print/prescription/${patientId}?rx=${blockedSavedPrintId}`} target="_blank" rel="noopener noreferrer" className="rounded bg-slate-900 px-3 py-2 font-bold text-white">فتح الوصفة المحفوظة للطباعة #{blockedSavedPrintId}</a>
          </div>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100"
            >
              إلغاء
            </button>
            {hasCriticalAlert && (
              <div className="flex items-center gap-1.5 rounded-xl border border-red-300 bg-red-100 px-3 py-1.5 text-xs font-black text-red-700 animate-pulse">
                <span>⛔</span>
                <span>تحذير: توجد أدوية تتعارض مع حالة المريض!</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {patientPhone && (
              <button
                type="button"
                onClick={handleWhatsApp}
                disabled
                title="المشاركة متوقفة حتى يتوفر مسار آمن للوصفة المحفوظة والمستلم والمحتوى"
                className="flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-xs font-bold text-emerald-800 hover:bg-emerald-100 transition-colors"
              >
                <span>💬</span>
                <span>واتساب غير متاح حاليًا</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => void handlePrint()}
              disabled={preserving || prescriberStatus !== "ready"}
              className="flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-bold text-white shadow hover:bg-slate-800 transition-all disabled:opacity-50"
            >
              <Icon name="print" className="h-4 w-4" />
              <span>{preserving ? "جارٍ حفظ الوصفة…" : "حفظ وطباعة الوصفة"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
