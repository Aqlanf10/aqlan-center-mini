"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { QuickAppointmentModal } from "@/components/QuickAppointmentModal";
import { PrescriptionModal } from "@/components/PrescriptionModal";
import { ConsentModal } from "@/components/ConsentModal";
import { PostOpModal } from "@/components/PostOpModal";
import { VitalsModal } from "@/components/VitalsModal";
import { CaseProfitabilityModal } from "@/components/CaseProfitabilityModal";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { CLINIC_BASE_CURRENCY } from "@/lib/money";
import type { Patient } from "@/lib/patient";
import styles from "./workspace.module.css";

export type WorkspaceAction = "book" | "prescription" | "consent" | "postop" | "vitals" | "profitability" | "tablet";

/** NEW RECONSTRUCTION. These adapters do not supply a guessed treating doctor or visit. */
export function WorkspaceDialogs({ authorityKey, action, patient, openVisitId, canWrite, canEditPatient, canViewProfitability, onClose, onChanged, onMedicalSaved, onConsentDraft, onConsentGuard }: {
  authorityKey: string; action: WorkspaceAction | null; patient: Patient; openVisitId: number | null;
  canWrite: boolean; canEditPatient: boolean; canViewProfitability: boolean;
  onClose: () => void; onChanged: () => void; onMedicalSaved: (value: string | null) => void;
  onConsentDraft?: (pending: boolean) => void; onConsentGuard?: (guard: (() => boolean) | null) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const today = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
  const identityKey = `${patient.id}:${authorityKey}:${today}`;
  // These callbacks can outlive their child dialog. An open/context transition
  // permanently retires them; returning to the same action is a new owner.
  const owner = useMemo(() => ({ identityKey, action, canWrite, canEditPatient, canViewProfitability }), [identityKey, action, canWrite, canEditPatient, canViewProfitability]);
  const activeOwner = useRef<typeof owner | null>(null);
  useLayoutEffect(() => {
    activeOwner.current = action === null ? null : owner;
    return () => { if (activeOwner.current === owner) activeOwner.current = null; };
  }, [owner, action]);
  const alive = (expected: WorkspaceAction) => activeOwner.current === owner && action === expected;
  const close = () => {
    if (activeOwner.current !== owner) return;
    activeOwner.current = null;
    onClose();
  };
  useEffect(() => {
    if (!action) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = host.current;
    const candidates = () => Array.from(root?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]') ?? []).filter((element) => element.getClientRects().length > 0);
    const first = candidates()[0]; first?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = candidates(); if (!items.length) return;
      const firstItem = items[0]; const lastItem = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === firstItem || !root?.contains(document.activeElement))) { event.preventDefault(); lastItem.focus(); }
      else if (!event.shiftKey && (document.activeElement === lastItem || !root?.contains(document.activeElement))) { event.preventDefault(); firstItem.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => { document.removeEventListener("keydown", trap); if (previous?.isConnected) previous.focus(); };
  }, [action, identityKey]);
  return <div ref={host}>
    {/* Remain mounted on Close within this patient/authority/day so the owner retains its draft semantics. */}
    {canWrite ? <PrescriptionModal key={`rx:${identityKey}`} authorityKey={authorityKey} isOpen={action === "prescription"} onClose={close} patientId={patient.id} patientName={patient.fullName} patientPhone={patient.phone} medicalAlert={patient.medicalAlert} /> : null}
    <ConsentModal key={`consent:${identityKey}`} authorityKey={authorityKey} isOpen={action === "consent"} onClose={close} patientId={patient.id} patientName={patient.fullName} onSigned={() => { if (alive("consent")) onChanged(); }} onDraftChange={onConsentDraft} onNavigationGuardChange={onConsentGuard} />
    <PostOpModal key={`postop:${identityKey}`} isOpen={action === "postop"} onClose={close} patientId={patient.id} patientName={patient.fullName} patientPhone={patient.phone} />
    {canWrite || canEditPatient ? <>
      <QuickAppointmentModal key={`book:${identityKey}`} isOpen={action === "book"} onClose={close} patientId={patient.id} patientName={patient.fullName} onSuccess={() => { if (alive("book")) onChanged(); }} />
      {canEditPatient ? <VitalsModal key={`vitals:${identityKey}`} authorityKey={authorityKey} isOpen={action === "vitals"} onClose={close} patientId={patient.id} patientName={patient.fullName} currentMedicalAlert={patient.medicalAlert} onSaved={(value) => { if (alive("vitals")) onMedicalSaved(value); if (alive("vitals")) onChanged(); }} /> : null}
    </> : null}
    {action === "profitability" && canViewProfitability ? <CaseProfitabilityModal key={`profitability:${identityKey}`} emptyStart title="محاكاة تقديرية لربحية الحالة" patientId={patient.id} patientName={patient.fullName} patientNumber={patient.patientNumber} currency={CLINIC_BASE_CURRENCY} procedures={[]} onClose={close} /> : null}
    {action === "tablet" ? <div className={styles.dialogBackdrop}><section className={styles.dialogPanel} role="dialog" aria-modal="true" aria-labelledby="workspace-tablet-title">
      <p className={styles.eyebrow}>التوثيق السريري</p><h2 id="workspace-tablet-title">أكمل العمل في زيارة اليوم</h2>
      <p>إضافة الإجراءات والملاحظات والمستهلكات وحفظها تتم من مساحة الزيارة الأصلية. وضع العرض اللمسي القديم لا يحفظ هذه الاختيارات في السجل.</p>
      <p className={styles.context}>رقم الملف <bdi>{patient.patientNumber}</bdi>{openVisitId ? ` · زيارة #${openVisitId}` : " · لا توجد زيارة مفتوحة مؤكّدة"}</p>
      <button type="button" className={styles.primaryButton} onClick={close}>العودة إلى زيارة اليوم</button>
    </section></div> : null}
  </div>;
}
