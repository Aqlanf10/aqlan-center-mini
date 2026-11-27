export type Language = 'ar' | 'en';

export type UserRole = 'doctor' | 'assistant' | 'reception' | 'admin';

export interface StaffUser {
  id: string;
  username: string;
  fullNameAr: string;
  fullNameEn: string;
  role: UserRole;
  titleAr: string;
  titleEn: string;
}

export type CaseStage =
  | 'intake'
  | 'examination'
  | 'records'
  | 'analysis'
  | 'planning'
  | 'active_treatment'
  | 'finishing'
  | 'retention'
  | 'completed';

export type OrthoPhase = 'aligning' | 'working' | 'finishing' | 'retention';
export type SlotSize = '018' | '022' | 'other';
export type ElasticClass = 'none' | 'class_ii' | 'class_iii' | 'vertical' | 'triangle' | 'box' | 'cross';

export type TriStateStatus = 'recorded' | 'unrecorded' | 'none' | 'unknown';
export type ExamTriState = 'normal' | 'not_examined' | 'not_applicable' | 'finding';

export interface TriStateField {
  status: TriStateStatus;
  value: string;
  note?: string;
}

export interface ExamField {
  status: ExamTriState;
  value: string;
  note?: string;
}

export interface QuestionnaireRevision {
  id: string;
  timestamp: string;
  author: string;
  authorRole: string;
  source: 'clinic' | 'pre_visit_link';
  fieldKey: string;
  previousValue: string;
  newValue: string;
}

export interface QuestionnaireData {
  medicalHistory: TriStateField;
  dentalHistory: TriStateField;
  medications: TriStateField;
  allergies: TriStateField;
  previousOrtho: TriStateField;
  oralHabits: TriStateField;
  functionalComplaints: TriStateField;
  customFields: Array<{
    id: string;
    labelAr: string;
    labelEn: string;
    field: TriStateField;
  }>;
  revisions: QuestionnaireRevision[];
  lastReviewedBy?: string;
  lastReviewedAt?: string;
}

export type ToothStatus =
  | 'present'
  | 'missing'
  | 'unerupted'
  | 'impacted'
  | 'restored'
  | 'caries'
  | 'extract_planned'
  | 'bracketed';

export interface ToothChartEntry {
  fdi: string;
  status: ToothStatus;
  note: string;
}

export interface ClinicalExam {
  examDate: string;
  examiner: string;
  extraoral: {
    symmetry: ExamField;
    facialProportions: ExamField;
    profile: ExamField;
    lipCompetence: ExamField;
    smileArc: ExamField;
    gingivalDisplay: ExamField;
    tmjFunction: ExamField;
    notes: string;
  };
  intraoral: {
    dentitionStage: ExamField;
    gingivalHealth: ExamField;
    molarRelRight: ExamField;
    molarRelLeft: ExamField;
    canineRelRight: ExamField;
    canineRelLeft: ExamField;
    overjetMm: ExamField;
    overbiteMm: ExamField;
    midlineUpper: ExamField;
    midlineLower: ExamField;
    crowdingUpper: ExamField;
    crowdingLower: ExamField;
    crossbite: ExamField;
    openBite: ExamField;
    deepBite: ExamField;
    archFormUpper: ExamField;
    archFormLower: ExamField;
    notes: string;
  };
  fdiChart: Record<string, ToothChartEntry>;
  approvedBy?: string;
  approvedAt?: string;
}

export type RecordStage = 'T0' | 'T1' | 'T2' | 'T3';
export type MediaKind = 'photo' | 'radiograph' | 'dicom' | 'model3d' | 'document';

export interface AnnotationItem {
  id: string;
  type: 'arrow' | 'line' | 'point' | 'angle' | 'text';
  x1: number;
  y1: number;
  x2?: number;
  y2?: number;
  x3?: number;
  y3?: number;
  text?: string;
  color: string;
}

export interface MediaEditorState {
  rotationDeg: number;
  tiltDeg: number;
  brightness: number;
  contrast: number;
  crop?: { x: number; y: number; w: number; h: number };
  anonymizeBar: { enabled: boolean; yPct: number; hPct: number };
  annotations: AnnotationItem[];
  updatedAt?: string;
  updatedBy?: string;
}

export interface CalibrationData {
  isCalibrated: boolean;
  pixelsPerMm: number | null;
  source: string;
  unit: 'mm';
  knownMm?: number;
  p1?: { x: number; y: number };
  p2?: { x: number; y: number };
}

export interface MediaRecord {
  id: string;
  title: string;
  mediaKind: MediaKind;
  stage: RecordStage;
  viewType: string;
  captureDate: string;
  uploadDate: string;
  source: string;
  notes: string;
  originalUrl: string;
  derivedUrl?: string;
  mimeType?: string;
  calibration: CalibrationData;
  editorState: MediaEditorState;
  isDerivedCopy?: boolean;
  parentMediaId?: string;
}

export interface AnalysisMetric {
  key: string;
  labelAr: string;
  labelEn: string;
  value: number | null;
  unit: 'mm' | 'deg' | '%';
  normRange: string;
  formulaDesc: string;
  interpretation: string;
  requiresCalibration: boolean;
}

export interface MeasurementAnalysis {
  id: string;
  version: number;
  stage: RecordStage;
  analysisType: 'cephalometric' | 'photo_analysis' | 'cast_bolton' | 'mixed_dentition' | 'model3d_mesh' | 'cbct_3d';
  dentitionType?: 'permanent' | 'mixed';
  analysisSystem?: string;
  photoViewMode?:
    | 'frontal'
    | 'profile'
    | 'smile'
    | 'intraoral_frontal'
    | 'intraoral_right'
    | 'intraoral_left'
    | 'intraoral_upper'
    | 'intraoral_lower';
  templateName: string;
  normSource: string;
  linkedMediaId?: string;
  calibrationValid: boolean;
  calibrationSource: string;
  landmarks: Record<string, { x: number; y: number }>;
  toothWidths?: Record<string, number>;
  spaceAvailableUpper?: number;
  spaceAvailableLower?: number;
  mixedDentitionData?: Record<string, number | string>;
  scannerMetrics?: Array<{
    key: string;
    labelAr: string;
    labelEn: string;
    value: number;
    unit: string;
  }>;
  cbctFindings?: {
    modality: string;
    fov: string;
    voxelMm: number;
    region: string;
    notes: string;
    measurements: Array<{
      id: string;
      plane: 'axial' | 'sagittal' | 'coronal';
      kind: 'distance' | 'angle';
      label: string;
      value: number;
      unit: string;
    }>;
  };
  notes?: string;
  metrics: AnalysisMetric[];
  examiner: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
}

export type ProblemCategory = 'skeletal' | 'dental' | 'soft_tissue' | 'functional' | 'other';

export interface ProblemItem {
  id: string;
  category: ProblemCategory;
  title: string;
  description: string;
  evidenceLinks: Array<{
    type: 'exam' | 'media' | 'analysis';
    refId: string;
    label: string;
  }>;
  priority: 'high' | 'medium' | 'low';
  status: 'active' | 'improving' | 'resolved';
}

export interface DiagnosisRecord {
  objectiveFindingsSummary: string;
  clinicalInterpretation: string;
  skeletalClass: string;
  dentalClass: string;
  verticalPattern: string;
  missingDataNotes: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface TreatmentGoal {
  id: string;
  problemId: string;
  title: string;
  targetMetric: string;
  plannedProcedure: string;
  executionStage: string;
  outcomeStatus: 'planned' | 'in_progress' | 'achieved' | 'modified';
}

export interface AlternativePlan {
  id: string;
  title: string;
  summary: string;
  pros: string;
  cons: string;
  isSelected: boolean;
  rationale: string;
}

export interface SecondaryApplianceItem {
  id: string;
  catalogId?: string;
  nameAr: string;
  nameEn: string;
  category: 'fixed_labial' | 'lingual_aligners' | 'expansion_orthopedic' | 'functional' | 'removable_space';
  arch: 'upper' | 'lower' | 'both';
  activationProtocol: string;
  placedDate: string;
  status: 'planned' | 'active' | 'completed';
  notes?: string;
}

export interface AuxiliaryItem {
  id: string;
  catalogId?: string;
  nameAr: string;
  nameEn: string;
  category: 'tads' | 'anchorage' | 'springs_chains' | 'bite_modifiers' | 'elastics_ipr';
  arch: 'upper' | 'lower' | 'both';
  site: string;
  spec: string;
  placedDate?: string;
  status: 'planned' | 'active' | 'completed';
  notes?: string;
}

export interface MechanotherapySpec {
  applianceType: 'fixed_mbt' | 'fixed_self_ligating' | 'clear_aligners' | 'removable_functional' | 'hybrid';
  primaryApplianceId?: string;
  slotSize?: SlotSize;
  bracketPrescription?: string;
  arches?: 'both' | 'upper' | 'lower';
  orthoPhase?: OrthoPhase;
  bracketSlot: string;
  wireSequence: string[];
  wireSequenceUpper?: string[];
  wireSequenceLower?: string[];
  elasticsProtocol: string;
  anchoragePlan: string;
  auxiliaries: string[];
  secondaryAppliances?: SecondaryApplianceItem[];
  auxiliaryItems?: AuxiliaryItem[];
  notes: string;
}

export interface PlanVersionEntry {
  version: number;
  date: string;
  author: string;
  reason: string;
  discussedWithPatient: boolean;
  approvedBy?: string;
}

export interface TreatmentPlan {
  estimatedDurationMonths: number | null;
  cooperationRequirements: string;
  referrals: string[];
  phases: Array<{
    id: string;
    name: string;
    durationMonths: number | null;
    objectives: string;
  }>;
  goals: TreatmentGoal[];
  alternatives: AlternativePlan[];
  mechanotherapy: MechanotherapySpec;
  versions: PlanVersionEntry[];
  approvedBy?: string;
  approvedAt?: string;
}

export interface TreatmentSession {
  id: string;
  visitNumber: number;
  date: string;
  clinician: string;
  visitType: 'routine' | 'bonding' | 'emergency' | 'repair' | 'missed' | 'debond';
  orthoPhase?: OrthoPhase;
  progressNotes: string;
  proceduresDone: string;
  archwireUpper: string;
  archwireLower: string;
  alignerStage: string;
  activationDetails: string;
  elasticClass?: ElasticClass;
  elasticsInstructed: string;
  auxiliariesUsed?: string[];
  cooperationLevel: 'excellent' | 'good' | 'fair' | 'poor';
  symptomsOrBreakages: string;
  changesFromPrevious: string;
  nextVisitPlan: string;
  nextIntervalWeeks?: number;
  suggestedNextDate: string;
  photoIds: string[];
  status: 'draft' | 'approved';
  approvedBy?: string;
  approvedAt?: string;
}

export interface RetentionRecord {
  debondDate: string;
  finalOutcomeVsGoals: string;
  upperRetainerType: string;
  lowerRetainerType: string;
  deliveryDate: string;
  wearProtocol: string;
  cooperation: string;
  followUpSchedule: Array<{
    id: string;
    intervalLabel: string;
    dueDate: string;
    completedDate?: string;
    status: 'scheduled' | 'completed' | 'missed';
    notes: string;
  }>;
  repairsAndReplacements: Array<{
    id: string;
    date: string;
    jaw: 'upper' | 'lower' | 'both';
    issue: string;
    actionTaken: string;
  }>;
  postTreatmentChanges: string;
}

export interface TimelineEvent {
  id: string;
  timestamp: string;
  actor: string;
  actorRole: string;
  category: 'intake' | 'exam' | 'media' | 'analysis' | 'diagnosis' | 'plan' | 'session' | 'retention' | 'approval' | 'report';
  summaryAr: string;
  summaryEn: string;
}

export interface PatientConsents {
  treatmentConsent: boolean;
  photoClinicalConsent: boolean;
  photoEducationalConsent: boolean;
  shareConsent: boolean;
  externalAiConsent: boolean;
  signedAt?: string;
  signedBy?: string;
}

export interface PatientCase {
  id: string;
  caseNumber: string;
  fullName: string;
  fullNameEn: string;
  dateOfBirth: string;
  gender: 'female' | 'male';
  phone: string;
  email: string;
  nationalId: string;
  address: string;
  guardianName: string;
  guardianPhone: string;
  guardianRelation: string;
  referralSource: string;
  chiefComplaintPatientWords: string;
  patientExpectations: string;
  stage: CaseStage;
  assignedDoctor: string;
  nextAppointmentDate: string;
  intakeToken: string;
  consents: PatientConsents;
  questionnaire: QuestionnaireData;
  clinicalExam: ClinicalExam;
  media: MediaRecord[];
  analyses: MeasurementAnalysis[];
  problems: ProblemItem[];
  dismissedAutoProblemIds?: string[];
  diagnosis: DiagnosisRecord;
  treatmentPlan: TreatmentPlan;
  sessions: TreatmentSession[];
  retention: RetentionRecord;
  timeline: TimelineEvent[];
  customReports: Array<{
    id: string;
    reportType: 'initial' | 'diagnosis_plan' | 'progress' | 'referral' | 'completion_retention';
    title: string;
    body: string;
    createdAt: string;
    createdBy: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export type VisitStatus = 'waiting' | 'called' | 'in_chair' | 'done' | 'cancelled';

export interface ClinicVisit {
  id: string;
  patientId: string | null;
  patientName: string;
  patientPhone: string;
  note: string;
  status: VisitStatus;
  chair: number | null;
  doctorName: string;
  visitKind: 'adjustment' | 'consultation' | 'bonding' | 'emergency' | 'retention';
  arrivedAt: string;
  calledAt: string | null;
  seatedAt: string | null;
  finishedAt: string | null;
  visitDate: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  actor: string;
  role: UserRole;
  action: string;
  targetType: string;
  targetId: string;
  details: string;
}

export interface ClinicSettings {
  clinicNameAr: string;
  clinicNameEn: string;
  allowExternalAi: boolean;
  chairCount?: number;
  waitWarningMinutes?: number;
  waitCriticalMinutes?: number;
  requiredViewsT0: string[];
  sessionTemplates: Array<{
    id: string;
    nameAr: string;
    nameEn: string;
    proceduresDone: string;
    archwireUpper: string;
    archwireLower: string;
    elasticsInstructed: string;
    nextVisitPlan: string;
  }>;
}
