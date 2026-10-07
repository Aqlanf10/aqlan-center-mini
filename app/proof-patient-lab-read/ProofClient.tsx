"use client";

import { useState } from "react";
import { PatientLabOrders } from "@/components/PatientLabOrders";
import { SessionProvider, useSessionActions, type SessionInfo } from "@/components/SessionProvider";
import { SettingsProvider } from "@/components/SettingsProvider";
import { DEFAULT_DOCTOR_PERMISSIONS } from "@/lib/doctor-permissions";

// Real React/component/providers; only the controls and patient values are fixtures.
// No credential, backend permission or session cookie changes occur here.
const initialSession: SessionInfo = { username: "synthetic-admin", role: "admin" };
function Fixture() {
  const [patientId, setPatientId] = useState(82001);
  const [visible, setVisible] = useState(true);
  const { session, setSession } = useSessionActions();
  return <div className="mx-auto max-w-4xl space-y-4 p-3">
    <p className="text-sm">واجهة إثبات اصطناعية مؤقتة، ليست شاشة تشغيلية</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" data-testid="proof-patient-a" onClick={() => setPatientId(82001)}>مريض أ</button>
      <button type="button" data-testid="proof-patient-b" onClick={() => setPatientId(82002)}>مريض ب</button>
      <button type="button" data-testid="proof-username" onClick={() => setSession({ ...initialSession, username: "synthetic-other" })}>تغيير المستخدم</button>
      <button type="button" data-testid="proof-role" onClick={() => setSession({ ...initialSession, role: "doctor" })}>تغيير الدور</button>
      <button type="button" data-testid="proof-permissions" onClick={() => setSession({ ...initialSession, permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canEditPlans: true } })}>تغيير الصلاحيات</button>
      <button type="button" data-testid="proof-null" onClick={() => setSession(null)}>إزالة الهوية</button>
      <button type="button" data-testid="proof-restore" onClick={() => setSession(initialSession)}>استعادة الهوية</button>
      <button type="button" data-testid="proof-toggle" onClick={() => setVisible((value) => !value)}>إظهار وإخفاء</button>
    </div>
    <p data-testid="proof-owner">{patientId}:{session?.username ?? "none"}:{session?.role ?? "none"}</p>
    {visible && <section aria-label="قراءة المختبر الاصطناعية">
      <PatientLabOrders patientId={patientId} patientName={`مريض اصطناعي ${patientId}`} />
    </section>}
  </div>;
}
export function PatientLabReadProof() {
  return <SettingsProvider value={{ "clinic.name": "عيادة إثبات اصطناعية", "clinic.phone": "" }}>
    <SessionProvider value={initialSession}><Fixture /></SessionProvider>
  </SettingsProvider>;
}
