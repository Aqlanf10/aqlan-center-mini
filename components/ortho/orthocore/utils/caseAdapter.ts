"use client";

import type { OrthoWorkspaceRecord } from "@/lib/ortho-workspace-types";
import type { ClinicSettings, MediaRecord, PatientCase, TreatmentSession } from "../types/ortho";
import { REQUIRED_T0_VIEWS } from "../i18n/translations";

export interface LivePatientDocument {
  id: number;
  kind: string;
  title: string;
  mimeType?: string;
  sizeBytes?: number;
  takenOn: string | null;
  uploadedBy?: string;
  uploadedAt?: string;
  photoStage: string | null;
  photoView: string | null;
  adjustmentId: number | null;
  note?: string | null;
}

export interface LiveOrthoCaseSummary {
  id: number;
  phase?: string;
  status?: string;
  upperWire?: string | null;
  lowerWire?: string | null;
  responsibleDoctorName?: string | null;
  adjustments?: Array<{
    id: number;
    doneOn: string;
    upperWire: string | null;
    lowerWire: string | null;
    elastics?: string | null;
    done: string | null;
    nextWeeks: number;
    note: string | null;
    recordedBy: string;
    photos?: Array<{ id: number }>;
  }>;
}

export function buildClinicSettingsForOrthoCore(clinicName: string): ClinicSettings {
  return {
    clinicNameAr: clinicName || "مركز الدكتور عقلان",
    clinicNameEn: "Dr. Aqlan Dental & Orthodontic Center",
    allowExternalAi: false,
    requiredViewsT0: REQUIRED_T0_VIEWS.map((v) => v.key),
    sessionTemplates: [
      {
        id: "tpl-align",
        nameAr: "تفعيل الترصيف والتسوية (NiTi)",
        nameEn: "Alignment & Leveling Activation",
        proceduresDone: "تغيير المطاطات والتحقق من سلامة الحاصرات وتفعيل سلك NiTi",
        archwireUpper: "0.016 NiTi",
        archwireLower: "0.014 NiTi",
        elasticsInstructed: "بدون مطاطات",
        nextVisitPlan: "متابعة الترصيف والترقية لسلك 0.016x0.022 NiTi",
      },
      {
        id: "tpl-space",
        nameAr: "إغلاق المسافات (Power Chain / SS)",
        nameEn: "Space Closure Activation",
        proceduresDone: "تركيب Power Chain وتفعيل إغلاق المسافات على سلك مستطيل",
        archwireUpper: "0.019x0.025 SS",
        archwireLower: "0.019x0.025 SS",
        elasticsInstructed: "مطاطات Class II 3/16 4.5oz",
        nextVisitPlan: "تقييم إغلاق المسافة والتأكد من تطابق الخط الوسطي",
      },
    ],
  };
}

function mapDocToMediaRecord(doc: LivePatientDocument): MediaRecord {
  const lower = (doc.title || "").toLowerCase();
  const mediaKind: MediaRecord["mediaKind"] =
    doc.kind === "xray" || doc.kind === "ceph" || lower.includes("ceph") || lower.includes("opg")
      ? "radiograph"
      : lower.endsWith(".dcm")
        ? "dicom"
        : lower.endsWith(".stl") || lower.endsWith(".obj")
          ? "model3d"
          : "photo";

  const stage: MediaRecord["stage"] =
    doc.photoStage === "start" || doc.photoStage === "initial"
      ? "T0"
      : doc.photoStage === "final" || doc.photoStage === "debond"
        ? "T2"
        : doc.photoStage === "retention"
          ? "T3"
          : "T1";

  const viewMap: Record<string, string> = {
    frontal: "intraoral_frontal",
    right_buccal: "intraoral_right",
    left_buccal: "intraoral_left",
    upper_occlusal: "intraoral_upper",
    lower_occlusal: "intraoral_lower",
    profile: "extraoral_profile",
    smile: "extraoral_frontal_smile",
    frontal_rest: "extraoral_frontal_rest",
  };
  const viewType = (doc.photoView && viewMap[doc.photoView]) || doc.photoView || "intraoral_frontal";
  const today = doc.takenOn || doc.uploadedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);

  return {
    id: `doc-${doc.id}`,
    title: doc.title || `مستند #${doc.id}`,
    mediaKind,
    stage,
    viewType,
    captureDate: today,
    uploadDate: doc.uploadedAt?.slice(0, 10) || today,
    source: doc.uploadedBy || "الطاقم",
    notes: doc.note || (doc.adjustmentId ? `مرتبط بشدّة #${doc.adjustmentId}` : ""),
    originalUrl: `/api/documents/${doc.id}`,
    mimeType: doc.mimeType || "image/png",
    calibration: {
      isCalibrated: false,
      pixelsPerMm: null,
      source: "uncalibrated",
      unit: "mm",
    },
    editorState: {
      rotationDeg: 0,
      tiltDeg: 0,
      brightness: 100,
      contrast: 100,
      anonymizeBar: { enabled: false, yPct: 30, hPct: 12 },
      annotations: [],
    },
    isDerivedCopy: Boolean(doc.note?.includes("[نسخة مشتقة]")),
  };
}

function emptyTriState(value = ""): { status: "recorded" | "unrecorded"; value: string } {
  return value.trim() ? { status: "recorded", value } : { status: "unrecorded", value: "" };
}

function emptyExamField(value = ""): { status: "finding" | "not_examined"; value: string } {
  return value.trim() ? { status: "finding", value } : { status: "not_examined", value: "" };
}

export function buildOrthoCorePatientCase(input: {
  patientId: number;
  patientName: string;
  patientCode: string;
  record: OrthoWorkspaceRecord;
  liveDocs?: LivePatientDocument[];
  liveCase?: LiveOrthoCaseSummary | null;
  canViewPhotos?: boolean;
}): PatientCase {
  const { patientId, patientName, patientCode, record, liveDocs = [], liveCase = null, canViewPhotos = true } = input;
  const now = new Date().toISOString();
  const saved = (record.orthoCoreCase && typeof record.orthoCoreCase === "object"
    ? record.orthoCoreCase
    : null) as Partial<PatientCase> | null;

  const baseCase: PatientCase = {
    id: String(patientId),
    caseNumber: patientCode || `P-${patientId}`,
    fullName: patientName,
    fullNameEn: patientName,
    dateOfBirth: "",
    gender: "male",
    phone: "",
    email: "",
    nationalId: "",
    address: "",
    guardianName: "",
    guardianPhone: "",
    guardianRelation: "",
    referralSource: "",
    chiefComplaintPatientWords: record.questionnaire.chiefComplaint || "",
    patientExpectations: record.questionnaire.patientExpectations || "",
    stage: liveCase?.status === "retention" ? "retention" : liveCase ? "active_treatment" : "intake",
    assignedDoctor: liveCase?.responsibleDoctorName || "الطبيب المسؤول",
    nextAppointmentDate: "",
    intakeToken: `aqlan-${patientId}`,
    consents: {
      treatmentConsent: Boolean(liveCase),
      photoClinicalConsent: true,
      photoEducationalConsent: record.questionnaire.consentForEducationDeidentified,
      shareConsent: false,
      externalAiConsent: false,
      signedAt: record.questionnaire.consentSignedOn ?? undefined,
    },
    questionnaire: {
      medicalHistory: emptyTriState(record.questionnaire.medicalAlertsSummary),
      dentalHistory: emptyTriState(""),
      medications: emptyTriState(record.questionnaire.medications),
      allergies: emptyTriState(record.questionnaire.allergies),
      previousOrtho: emptyTriState(record.questionnaire.priorOrthoDetails),
      oralHabits: emptyTriState(
        [
          record.questionnaire.habits.thumbSucking && "مص الأصابع",
          record.questionnaire.habits.mouthBreathing && "تنفس فموي",
          record.questionnaire.habits.tongueThrust && "دفع اللسان",
          record.questionnaire.habits.bruxism && "صرير الأسنان",
          record.questionnaire.habits.other,
        ]
          .filter(Boolean)
          .join("، "),
      ),
      functionalComplaints: emptyTriState(record.questionnaire.tmjSymptoms.notes),
      customFields: [],
      revisions: [],
    },
    clinicalExam: {
      examDate: record.updatedAt?.slice(0, 10) || now.slice(0, 10),
      examiner: record.updatedBy || liveCase?.responsibleDoctorName || "",
      extraoral: {
        symmetry: emptyExamField(record.clinicalExam.extraoral.facialSymmetry),
        facialProportions: emptyExamField(record.clinicalExam.extraoral.facialForm),
        profile: emptyExamField(record.clinicalExam.extraoral.profileType),
        lipCompetence: emptyExamField(record.clinicalExam.extraoral.lipCompetence),
        smileArc: emptyExamField(record.clinicalExam.extraoral.smileArc),
        gingivalDisplay: emptyExamField(
          record.clinicalExam.extraoral.gingivalDisplayMm != null
            ? `${record.clinicalExam.extraoral.gingivalDisplayMm} mm`
            : "",
        ),
        tmjFunction: emptyExamField(record.questionnaire.tmjSymptoms.notes),
        notes: record.clinicalExam.extraoral.notes || "",
      },
      intraoral: {
        dentitionStage: emptyExamField(record.clinicalExam.dentitionStage),
        gingivalHealth: emptyExamField(record.clinicalExam.intraoral.gingivalHealth),
        molarRelRight: emptyExamField(record.clinicalExam.intraoral.molarRight),
        molarRelLeft: emptyExamField(record.clinicalExam.intraoral.molarLeft),
        canineRelRight: emptyExamField(record.clinicalExam.intraoral.canineRight),
        canineRelLeft: emptyExamField(record.clinicalExam.intraoral.canineLeft),
        overjetMm: emptyExamField(
          record.clinicalExam.intraoral.overjetMm != null ? String(record.clinicalExam.intraoral.overjetMm) : "",
        ),
        overbiteMm: emptyExamField(
          record.clinicalExam.intraoral.overbiteMm != null ? String(record.clinicalExam.intraoral.overbiteMm) : "",
        ),
        midlineUpper: emptyExamField(
          record.clinicalExam.intraoral.upperMidlineShiftMm != null
            ? `${record.clinicalExam.intraoral.upperMidlineShiftMm} mm`
            : "",
        ),
        midlineLower: emptyExamField(
          record.clinicalExam.intraoral.lowerMidlineShiftMm != null
            ? `${record.clinicalExam.intraoral.lowerMidlineShiftMm} mm`
            : "",
        ),
        crowdingUpper: emptyExamField(""),
        crowdingLower: emptyExamField(""),
        crossbite: emptyExamField(
          record.clinicalExam.intraoral.crossbitePosterior !== "none"
            ? record.clinicalExam.intraoral.crossbitePosterior
            : "",
        ),
        openBite: emptyExamField(
          record.clinicalExam.intraoral.openBiteAnteriorMm != null
            ? `${record.clinicalExam.intraoral.openBiteAnteriorMm} mm`
            : "",
        ),
        deepBite: emptyExamField(""),
        archFormUpper: emptyExamField(record.clinicalExam.intraoral.archFormUpper),
        archFormLower: emptyExamField(record.clinicalExam.intraoral.archFormLower),
        notes: record.clinicalExam.intraoral.notes || "",
      },
      fdiChart: Object.fromEntries(
        Object.entries(record.clinicalExam.teeth).map(([fdi, t]) => [
          fdi,
          {
            fdi,
            status:
              t.status === "extracted"
                ? "missing"
                : t.status === "deciduous_retained"
                  ? "present"
                  : (t.status as "present" | "missing" | "unerupted" | "impacted"),
            note: t.widthMm != null ? `${t.widthMm}mm${t.note ? ` · ${t.note}` : ""}` : t.note || "",
          },
        ]),
      ),
    },
    media: [],
    analyses: [],
    problems: record.problems.map((p) => ({
      id: p.id,
      category: p.category === "space" || p.category === "periodontal" ? "dental" : p.category,
      title: p.titleAr,
      description: p.detailsAr,
      evidenceLinks: [],
      priority: p.severity === "severe" ? "high" : p.severity === "moderate" ? "medium" : "low",
      status: "active",
    })),
    dismissedAutoProblemIds: [],
    diagnosis: {
      objectiveFindingsSummary: record.diagnosisSummary.softTissueSummary || "",
      clinicalInterpretation: record.diagnosisSummary.finalDiagnosisAr || "",
      skeletalClass: record.diagnosisSummary.skeletalClass || "",
      dentalClass: record.diagnosisSummary.dentalClass || "",
      verticalPattern: record.diagnosisSummary.verticalPattern || "",
      missingDataNotes: "",
      approvedBy: record.diagnosisSummary.approvedBy ?? undefined,
      approvedAt: record.diagnosisSummary.approvedAt ?? undefined,
    },
    treatmentPlan: {
      estimatedDurationMonths: record.treatmentPlan.estimatedDurationMonths,
      cooperationRequirements: record.treatmentPlan.risksDiscussed || "",
      referrals: [],
      phases: record.treatmentPlan.phaseBreakdown.map((ph, idx) => ({
        id: `ph-${idx}`,
        name: ph.phase,
        durationMonths: ph.estimatedMonths,
        objectives: `${ph.objective}${ph.wiresOrAppliance ? ` (${ph.wiresOrAppliance})` : ""}`,
      })),
      goals: record.treatmentPlan.primaryGoals.map((g, idx) => ({
        id: `g-${idx}`,
        problemId: "",
        title: g,
        targetMetric: "",
        plannedProcedure: "",
        executionStage: "",
        outcomeStatus: "in_progress",
      })),
      alternatives: [],
      mechanotherapy: {
        applianceType: "fixed_mbt",
        bracketSlot: record.treatmentPlan.bracketSystem || "0.022 MBT",
        wireSequence: ["0.014 NiTi", "0.016 NiTi", "0.016x0.022 NiTi", "0.019x0.025 SS"],
        elasticsProtocol: "",
        anchoragePlan: record.treatmentPlan.anchoragePlan || "",
        auxiliaries: [],
        notes: record.treatmentPlan.mechanicsSummary || "",
      },
      versions: [],
      approvedBy: record.treatmentPlan.approvedBy ?? undefined,
      approvedAt: record.treatmentPlan.approvedAt ?? undefined,
    },
    sessions: [],
    retention: {
      debondDate: record.retention.debondDate || "",
      finalOutcomeVsGoals: "",
      upperRetainerType: record.retention.upperRetainerType || "",
      lowerRetainerType: record.retention.lowerRetainerType || "",
      deliveryDate: record.retention.debondDate || "",
      wearProtocol: record.retention.wearProtocol || "",
      cooperation: "",
      followUpSchedule: record.retention.followups.map((f) => ({
        id: f.id,
        intervalLabel: f.intervalLabel,
        dueDate: f.date,
        completedDate: f.date,
        status: "completed",
        notes: f.notes,
      })),
      repairsAndReplacements: [],
      postTreatmentChanges: "",
    },
    timeline: [],
    customReports: [],
    createdAt: record.updatedAt || now,
    updatedAt: record.updatedAt || now,
  };

  // Merge persisted OrthoCore snapshot cleanly over base defaults
  const merged: PatientCase = saved
    ? {
        ...baseCase,
        ...saved,
        id: String(patientId),
        caseNumber: patientCode || baseCase.caseNumber,
        fullName: patientName,
        assignedDoctor: liveCase?.responsibleDoctorName || saved.assignedDoctor || baseCase.assignedDoctor,
        questionnaire: saved.questionnaire ?? baseCase.questionnaire,
        clinicalExam: saved.clinicalExam ?? baseCase.clinicalExam,
        diagnosis: saved.diagnosis ?? baseCase.diagnosis,
        treatmentPlan: saved.treatmentPlan ?? baseCase.treatmentPlan,
        retention: saved.retention ?? baseCase.retention,
        consents: saved.consents ?? baseCase.consents,
        analyses: Array.isArray(saved.analyses) ? saved.analyses : baseCase.analyses,
        problems: Array.isArray(saved.problems) ? saved.problems : baseCase.problems,
        timeline: Array.isArray(saved.timeline) ? saved.timeline : [],
        customReports: Array.isArray(saved.customReports) ? saved.customReports : [],
      }
    : baseCase;

  // Sync live PostgreSQL tightening sessions into merged.sessions (for Reports/Header/Timeline!)
  if (liveCase?.adjustments && liveCase.adjustments.length > 0) {
    const syncedSessions: TreatmentSession[] = liveCase.adjustments.map((a, idx) => ({
      id: `adj-${a.id}`,
      visitNumber: liveCase.adjustments!.length - idx,
      date: a.doneOn,
      clinician: a.recordedBy,
      visitType: "routine",
      progressNotes: a.note || "",
      proceduresDone: a.done || "",
      archwireUpper: a.upperWire || "",
      archwireLower: a.lowerWire || "",
      alignerStage: "",
      activationDetails: "",
      elasticsInstructed: a.elastics || "",
      cooperationLevel: "good",
      symptomsOrBreakages: "",
      changesFromPrevious: "",
      nextVisitPlan: "",
      nextIntervalWeeks: a.nextWeeks,
      suggestedNextDate: "",
      photoIds: (a.photos ?? []).map((p) => `doc-${p.id}`),
      status: "approved",
    }));
    merged.sessions = syncedSessions;
  }

  // Sync live authenticated PostgreSQL patient documents into merged.media (respecting photos.view!)
  if (!canViewPhotos) {
    merged.media = [];
  } else {
    const existingMedia = Array.isArray(merged.media) ? merged.media : [];
    const byUrl = new Map<string, MediaRecord>();
    for (const m of existingMedia) {
      if (m.originalUrl && m.originalUrl.startsWith("/api/documents/")) byUrl.set(m.originalUrl, m);
    }
    for (const doc of liveDocs) {
      const mapped = mapDocToMediaRecord(doc);
      if (!byUrl.has(mapped.originalUrl)) {
        byUrl.set(mapped.originalUrl, mapped);
      }
    }
    merged.media = Array.from(byUrl.values());
  }

  return merged;
}

export function applyOrthoCoreCaseToWorkspace(
  baseRecord: OrthoWorkspaceRecord,
  nextCase: PatientCase,
): OrthoWorkspaceRecord {
  const approvedAnalyses = nextCase.analyses
    .filter((a) => Boolean(a.approvedAt))
    .map((a) => ({
      id: a.id,
      type: (a.analysisType === "cephalometric"
        ? "ceph"
        : a.analysisType === "cast_bolton"
          ? "bolton"
          : a.analysisType === "mixed_dentition"
            ? "moyers"
            : "facial_photo") as OrthoWorkspaceRecord["approvedAnalyses"][number]["type"],
      titleAr: a.templateName || a.analysisType,
      summaryAr: a.metrics.slice(0, 4).map((m) => `${m.labelAr}: ${m.value ?? "—"} ${m.unit}`).join(" · "),
      values: Object.fromEntries(a.metrics.map((m) => [m.key, m.value])),
      approvedBy: a.approvedBy || "الطبيب",
      approvedAt: a.approvedAt || new Date().toISOString(),
      referenceCitation: a.normSource || "Contemporary Orthodontics 7th Ed",
    }));

  return {
    ...baseRecord,
    questionnaire: {
      ...baseRecord.questionnaire,
      chiefComplaint: nextCase.chiefComplaintPatientWords || baseRecord.questionnaire.chiefComplaint,
      patientExpectations: nextCase.patientExpectations || baseRecord.questionnaire.patientExpectations,
      consentForEducationDeidentified: Boolean(nextCase.consents?.photoEducationalConsent),
      consentSignedOn: nextCase.consents?.signedAt ?? baseRecord.questionnaire.consentSignedOn,
    },
    approvedAnalyses: approvedAnalyses.length > 0 ? approvedAnalyses : baseRecord.approvedAnalyses,
    diagnosisSummary: {
      ...baseRecord.diagnosisSummary,
      skeletalClass: nextCase.diagnosis.skeletalClass || baseRecord.diagnosisSummary.skeletalClass,
      dentalClass: nextCase.diagnosis.dentalClass || baseRecord.diagnosisSummary.dentalClass,
      verticalPattern: nextCase.diagnosis.verticalPattern || baseRecord.diagnosisSummary.verticalPattern,
      finalDiagnosisAr: nextCase.diagnosis.clinicalInterpretation || baseRecord.diagnosisSummary.finalDiagnosisAr,
      approvedBy: nextCase.diagnosis.approvedBy ?? baseRecord.diagnosisSummary.approvedBy,
      approvedAt: nextCase.diagnosis.approvedAt ?? baseRecord.diagnosisSummary.approvedAt,
    },
    treatmentPlan: {
      ...baseRecord.treatmentPlan,
      primaryGoals:
        nextCase.treatmentPlan.goals.length > 0
          ? nextCase.treatmentPlan.goals.map((g) => g.title).filter(Boolean)
          : baseRecord.treatmentPlan.primaryGoals,
      mechanicsSummary: nextCase.treatmentPlan.mechanotherapy.notes || baseRecord.treatmentPlan.mechanicsSummary,
      estimatedDurationMonths:
        nextCase.treatmentPlan.estimatedDurationMonths ?? baseRecord.treatmentPlan.estimatedDurationMonths,
      approvedBy: nextCase.treatmentPlan.approvedBy ?? baseRecord.treatmentPlan.approvedBy,
      approvedAt: nextCase.treatmentPlan.approvedAt ?? baseRecord.treatmentPlan.approvedAt,
    },
    orthoCoreCase: nextCase as unknown as Record<string, unknown>,
  };
}
