"use client";

import { useState } from "react";
import { MedicalHistoryPanel } from "@/components/MedicalHistoryPanel";
import { VitalsModal } from "@/components/VitalsModal";
import { PatientIntakeHistory } from "@/components/patient/PatientIntakeHistory";

/**
 * التوثيق السريري في ملف المريض الموحّد (M2 slice 74) — لمن يملك clinical.visits.document:
 * التاريخ الطبي (نسخة جديدة)، والعلامات الحيوية مع التنبيه الطبي، واستمارة الصحة. كل حفظٍ
 * بمعاملة موحّدة داخل نطاق المرضى وبمفتاح طلب يمنع التكرار؛ والخادم يرفض ما لا تملكه.
 */
export function CanonicalClinicalDocumentation({ patientId, patientName, medicalAlert, onChanged }: {
  patientId: number; patientName: string; medicalAlert: string | null; onChanged: () => void;
}) {
  const [vitalsOpen, setVitalsOpen] = useState(false);
  return (
    <section aria-labelledby="canonical-clinical-documentation" className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="clinical-documentation">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="canonical-clinical-documentation" className="text-sm font-bold text-navy-900">التوثيق السريري</h2>
        <button type="button" onClick={() => setVitalsOpen(true)} data-testid="vitals-open"
          className="min-h-10 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">تسجيل علامات حيوية</button>
      </div>
      <MedicalHistoryPanel patientId={patientId} />
      <div className="mt-3"><PatientIntakeHistory patientId={patientId} /></div>
      <VitalsModal isOpen={vitalsOpen} onClose={() => setVitalsOpen(false)} patientId={patientId} patientName={patientName}
        currentMedicalAlert={medicalAlert} onSaved={() => { setVitalsOpen(false); onChanged(); }} />
    </section>
  );
}
