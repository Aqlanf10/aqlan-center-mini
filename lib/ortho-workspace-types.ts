/**
 * AQLAN Center Mini — Unified Advanced Orthodontic Workspace Types
 *
 * Adapted from the OrthoCore clinical workflow to complement AQLAN Center Mini's
 * native PostgreSQL tables (`ortho_cases`, `ortho_adjustments`, `patient_documents`,
 * `ceph_analyses`, `ortho_assessments`, `ortho_treatment_strategies`).
 */

import type { OrthoSectionKey } from "./ortho-privacy";

export type OrthoWorkspaceTabId =
  | "overview"
  | "questionnaire"
  | "exam"
  | "media"
  | "analysis"
  | "diagnosis"
  | "plan"
  | "sessions"
  | "retention"
  | "reports";

export interface OrthoWorkspaceTabDef {
  id: OrthoWorkspaceTabId;
  ar: string;
  en: string;
  sectionKey: OrthoSectionKey;
}

/** Exact sequential clinical tab order matching OrthoCore. */
export const ORTHO_WORKSPACE_TABS: readonly OrthoWorkspaceTabDef[] = [
  { id: "overview", ar: "البيانات", en: "Overview", sectionKey: "overview" },
  { id: "questionnaire", ar: "الاستبيان", en: "Questionnaire", sectionKey: "medical_history" },
  { id: "exam", ar: "الفحص", en: "Clinical Exam", sectionKey: "exam" },
  { id: "media", ar: "الصور والأشعة", en: "Media & 3D", sectionKey: "media" },
  { id: "analysis", ar: "القياسات والتحليلات", en: "Measurements", sectionKey: "measurements" },
  { id: "diagnosis", ar: "المشكلات والتشخيص", en: "Problems & Diagnosis", sectionKey: "diagnosis" },
  { id: "plan", ar: "خطة العلاج والأجهزة", en: "Plan & Appliances", sectionKey: "plan" },
  { id: "sessions", ar: "الشدّات والجلسات", en: "Tightenings & Sessions", sectionKey: "sessions" },
  { id: "retention", ar: "التثبيت", en: "Retention", sectionKey: "retention" },
  { id: "reports", ar: "التقارير والطباعة", en: "Reports & Presentation", sectionKey: "reports" },
] as const;

export type DentitionStage = "deciduous" | "mixed" | "permanent";
export type AngleClass = "Class I" | "Class II div 1" | "Class II div 2" | "Class III" | "";
export type ToothStatus = "present" | "missing" | "impacted" | "unerupted" | "extracted" | "deciduous_retained";

export interface FdiToothRecord {
  fdi: number;
  dentition: "permanent" | "deciduous";
  status: ToothStatus;
  widthMm: number | null;
  note?: string;
}

export interface OrthoQuestionnaire {
  chiefComplaint: string;
  patientExpectations: string;
  priorOrthoTreatment: boolean;
  priorOrthoDetails: string;
  habits: {
    thumbSucking: boolean;
    mouthBreathing: boolean;
    tongueThrust: boolean;
    bruxism: boolean;
    nailBiting: boolean;
    other: string;
  };
  tmjSymptoms: {
    clicking: boolean;
    pain: boolean;
    limitedOpening: boolean;
    deviation: boolean;
    notes: string;
  };
  medicalAlertsSummary: string;
  allergies: string;
  medications: string;
  growthStatus: "pre_pubertal" | "peak_growth" | "post_pubertal" | "adult" | "";
  consentForEducationDeidentified: boolean;
  consentSignedOn: string | null;
}

export interface OrthoClinicalExam {
  dentitionStage: DentitionStage;
  extraoral: {
    facialForm: "mesofacial" | "dolichofacial" | "brachyfacial" | "";
    profileType: "straight" | "convex" | "concave" | "";
    facialSymmetry: "symmetric" | "chin_left" | "chin_right" | "asymmetric" | "";
    lipCompetence: "competent" | "potentially_competent" | "incompetent" | "";
    nasolabialAngle: "normal" | "acute" | "obtuse" | "";
    smileArc: "consonant" | "flat" | "reverse" | "";
    gingivalDisplayMm: number | null;
    buccalCorridor: "normal" | "narrow" | "wide" | "";
    notes: string;
  };
  intraoral: {
    oralHygiene: "good" | "fair" | "poor" | "";
    gingivalHealth: "healthy" | "gingivitis" | "periodontitis" | "";
    molarRight: AngleClass;
    molarLeft: AngleClass;
    canineRight: AngleClass;
    canineLeft: AngleClass;
    overjetMm: number | null;
    overbiteMm: number | null;
    overbitePercent: number | null;
    upperMidlineShiftMm: number | null;
    lowerMidlineShiftMm: number | null;
    crossbiteAnterior: boolean;
    crossbitePosterior: "none" | "right" | "left" | "bilateral";
    openBiteAnteriorMm: number | null;
    curveOfSpeeMm: number | null;
    archFormUpper: "ovoid" | "tapered" | "square" | "";
    archFormLower: "ovoid" | "tapered" | "square" | "";
    upperAvailableSpaceMm: number | null;
    lowerAvailableSpaceMm: number | null;
    notes: string;
  };
  /** Keyed by FDI tooth number string e.g. "11", "55" */
  teeth: Record<string, FdiToothRecord>;
}

export interface FacialPhotoCalibration {
  documentId: number | null;
  pixelSpacingMm: number | null;
  /** Normalized 0..1 coordinates for facial proportions */
  landmarks: Record<string, { x: number; y: number }>;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface Model3DAnnotation {
  documentId: number | null;
  format: "stl" | "obj" | "ply" | "other";
  calibratedMmPerUnit: number | null;
  intercanineUpperMm: number | null;
  intercanineLowerMm: number | null;
  intermolarUpperMm: number | null;
  intermolarLowerMm: number | null;
  palatalDepthMm: number | null;
  notes: string;
}

export interface CbctSliceGuardRecord {
  documentId: number | null;
  modality: "cbct_3d_volume" | "cbct_2d_slice" | "opg_2d" | "lateral_ceph_2d";
  pixelSpacingMm: number | null;
  sliceThicknessMm: number | null;
  airwayNotes: string;
  impactionNotes: string;
  rootResorptionNotes: string;
}

export interface ApprovedAnalysisSnapshot {
  id: string;
  type: "bolton" | "moyers" | "tanaka_johnston" | "nance" | "pont" | "ashley_howe" | "facial_photo" | "ceph";
  titleAr: string;
  summaryAr: string;
  values: Record<string, number | string | null>;
  approvedBy: string;
  approvedAt: string;
  referenceCitation: string;
}

export interface OrthoProblemItem {
  id: string;
  category: "skeletal" | "dental" | "soft_tissue" | "functional" | "periodontal" | "space";
  severity: "mild" | "moderate" | "severe";
  titleAr: string;
  detailsAr: string;
  source: "manual" | "approved_analysis" | "approved_ceph" | "clinical_exam";
  sourceRefId?: string;
  approved: boolean;
}

export interface OrthoTreatmentPlan {
  primaryGoals: string[];
  treatmentModality:
    | "fixed_metallic"
    | "fixed_ceramic"
    | "self_ligating"
    | "clear_aligners"
    | "functional_growth"
    | "surgical_ortho"
    | "interceptive"
    | "";
  extractionPlan: "non_extraction" | "extraction" | "borderline_reassess" | "";
  extractionTeethFdi: number[];
  anchoragePlan: "minimum" | "moderate" | "maximum" | "tad_skeletal" | "";
  mechanicsSummary: string;
  bracketSystem: string;
  estimatedDurationMonths: number | null;
  phaseBreakdown: Array<{
    phase: string;
    objective: string;
    wiresOrAppliance: string;
    estimatedMonths: number | null;
  }>;
  risksDiscussed: string;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface OrthoRetentionRecord {
  debondDate: string | null;
  upperRetainerType: "hawley" | "essix" | "fixed_bonded" | "dual_bonded_essix" | "none" | "";
  lowerRetainerType: "hawley" | "essix" | "fixed_bonded" | "dual_bonded_essix" | "none" | "";
  wearProtocol: string;
  followups: Array<{
    id: string;
    date: string;
    intervalLabel: string;
    compliance: "excellent" | "good" | "fair" | "poor";
    retainerIntegrity: "intact" | "debonded" | "cracked" | "lost" | "replaced";
    relapseObserved: boolean;
    notes: string;
    clinician: string;
  }>;
}

export interface CasePresentationPreferences {
  defaultAnonymize: boolean;
  includeClinicLogo: boolean;
  selectedSlideIds: string[];
  presenterNotes: string;
}

export interface OrthoWorkspaceRecord {
  schemaVersion: 1;
  patientId: number;
  orthoCaseId: number | null;
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
  questionnaire: OrthoQuestionnaire;
  clinicalExam: OrthoClinicalExam;
  facialPhoto: FacialPhotoCalibration;
  model3d: Model3DAnnotation;
  cbct: CbctSliceGuardRecord;
  /** Additional cast parameters used by Pont / Ashley Howe / Nance / Moyers */
  castInputs: {
    moyersPercentile: 50 | 75 | 85 | 95;
    upperPremolarWidthMm: number | null;
    upperMolarWidthMm: number | null;
    premolarBasalArchWidthMm: number | null;
    nanceUpperPredictedMm: number | null;
    nanceLowerPredictedMm: number | null;
    leewayUpperAvailableMm: number | null;
    leewayLowerAvailableMm: number | null;
  };
  approvedAnalyses: ApprovedAnalysisSnapshot[];
  problems: OrthoProblemItem[];
  diagnosisSummary: {
    skeletalClass: string;
    dentalClass: string;
    verticalPattern: string;
    transversePattern: string;
    softTissueSummary: string;
    finalDiagnosisAr: string;
    approvedBy: string | null;
    approvedAt: string | null;
  };
  treatmentPlan: OrthoTreatmentPlan;
  retention: OrthoRetentionRecord;
  presentation: CasePresentationPreferences;
}

export const PERMANENT_FDI_TEETH: readonly number[] = [
  18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28,
  48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38,
] as const;

export const DECIDUOUS_FDI_TEETH: readonly number[] = [
  55, 54, 53, 52, 51, 61, 62, 63, 64, 65,
  85, 84, 83, 82, 81, 71, 72, 73, 74, 75,
] as const;

export function createDefaultOrthoWorkspace(patientId: number, orthoCaseId: number | null = null): OrthoWorkspaceRecord {
  return {
    schemaVersion: 1,
    patientId,
    orthoCaseId,
    revision: 0,
    updatedAt: null,
    updatedBy: null,
    questionnaire: {
      chiefComplaint: "",
      patientExpectations: "",
      priorOrthoTreatment: false,
      priorOrthoDetails: "",
      habits: {
        thumbSucking: false,
        mouthBreathing: false,
        tongueThrust: false,
        bruxism: false,
        nailBiting: false,
        other: "",
      },
      tmjSymptoms: {
        clicking: false,
        pain: false,
        limitedOpening: false,
        deviation: false,
        notes: "",
      },
      medicalAlertsSummary: "",
      allergies: "",
      medications: "",
      growthStatus: "",
      consentForEducationDeidentified: false,
      consentSignedOn: null,
    },
    clinicalExam: {
      dentitionStage: "permanent",
      extraoral: {
        facialForm: "",
        profileType: "",
        facialSymmetry: "",
        lipCompetence: "",
        nasolabialAngle: "",
        smileArc: "",
        gingivalDisplayMm: null,
        buccalCorridor: "",
        notes: "",
      },
      intraoral: {
        oralHygiene: "",
        gingivalHealth: "",
        molarRight: "",
        molarLeft: "",
        canineRight: "",
        canineLeft: "",
        overjetMm: null,
        overbiteMm: null,
        overbitePercent: null,
        upperMidlineShiftMm: null,
        lowerMidlineShiftMm: null,
        crossbiteAnterior: false,
        crossbitePosterior: "none",
        openBiteAnteriorMm: null,
        curveOfSpeeMm: null,
        archFormUpper: "",
        archFormLower: "",
        upperAvailableSpaceMm: null,
        lowerAvailableSpaceMm: null,
        notes: "",
      },
      teeth: {},
    },
    facialPhoto: {
      documentId: null,
      pixelSpacingMm: null,
      landmarks: {},
      approvedBy: null,
      approvedAt: null,
    },
    model3d: {
      documentId: null,
      format: "stl",
      calibratedMmPerUnit: null,
      intercanineUpperMm: null,
      intercanineLowerMm: null,
      intermolarUpperMm: null,
      intermolarLowerMm: null,
      palatalDepthMm: null,
      notes: "",
    },
    cbct: {
      documentId: null,
      modality: "cbct_2d_slice",
      pixelSpacingMm: null,
      sliceThicknessMm: null,
      airwayNotes: "",
      impactionNotes: "",
      rootResorptionNotes: "",
    },
    castInputs: {
      moyersPercentile: 75,
      upperPremolarWidthMm: null,
      upperMolarWidthMm: null,
      premolarBasalArchWidthMm: null,
      nanceUpperPredictedMm: null,
      nanceLowerPredictedMm: null,
      leewayUpperAvailableMm: null,
      leewayLowerAvailableMm: null,
    },
    approvedAnalyses: [],
    problems: [],
    diagnosisSummary: {
      skeletalClass: "",
      dentalClass: "",
      verticalPattern: "",
      transversePattern: "",
      softTissueSummary: "",
      finalDiagnosisAr: "",
      approvedBy: null,
      approvedAt: null,
    },
    treatmentPlan: {
      primaryGoals: [],
      treatmentModality: "",
      extractionPlan: "",
      extractionTeethFdi: [],
      anchoragePlan: "",
      mechanicsSummary: "",
      bracketSystem: "",
      estimatedDurationMonths: null,
      phaseBreakdown: [],
      risksDiscussed: "",
      approvedBy: null,
      approvedAt: null,
    },
    retention: {
      debondDate: null,
      upperRetainerType: "",
      lowerRetainerType: "",
      wearProtocol: "",
      followups: [],
    },
    presentation: {
      defaultAnonymize: false,
      includeClinicLogo: true,
      selectedSlideIds: [
        "cover",
        "case_history",
        "facial_photos",
        "intraoral_photos",
        "radiographs_ceph",
        "measurements",
        "problem_diagnosis",
        "treatment_plan",
        "sessions_timeline",
        "before_after",
        "retention",
      ],
      presenterNotes: "",
    },
  };
}

/** Deterministic completeness check across core clinical stages (0..100). */
export function computeOrthoWorkspaceCompleteness(record: OrthoWorkspaceRecord): {
  percent: number;
  completedCount: number;
  totalCount: number;
  missingAr: string[];
} {
  const checks: Array<{ ok: boolean; labelAr: string }> = [
    { ok: record.questionnaire.chiefComplaint.trim().length > 0, labelAr: "الشكوى الرئيسية والاستبيان" },
    { ok: Boolean(record.clinicalExam.extraoral.profileType || record.clinicalExam.extraoral.facialForm), labelAr: "الفحص خارج الفم" },
    { ok: Boolean(record.clinicalExam.intraoral.molarRight || record.clinicalExam.intraoral.molarLeft), labelAr: "الفحص داخل الفم" },
    { ok: Object.keys(record.clinicalExam.teeth).length > 0, labelAr: "قياسات مخطط FDI" },
    { ok: record.approvedAnalyses.length > 0, labelAr: "تحليل معتمد واحد على الأقل" },
    { ok: record.problems.some((p) => p.approved) || Boolean(record.diagnosisSummary.finalDiagnosisAr.trim()), labelAr: "قائمة المشكلات والتشخيص" },
    { ok: Boolean(record.treatmentPlan.treatmentModality && record.treatmentPlan.primaryGoals.length > 0), labelAr: "أهداف وخطة العلاج" },
    { ok: Boolean(record.retention.upperRetainerType || record.retention.lowerRetainerType || record.retention.wearProtocol.trim()), labelAr: "خطة التثبيت" },
  ];
  const completedCount = checks.filter((c) => c.ok).length;
  const totalCount = checks.length;
  return {
    percent: Math.round((completedCount / totalCount) * 100),
    completedCount,
    totalCount,
    missingAr: checks.filter((c) => !c.ok).map((c) => c.labelAr),
  };
}
