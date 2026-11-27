import { CaseStage, Language, UserRole } from '../types/ortho';

export const STAGE_LABELS: Record<CaseStage, { ar: string; en: string }> = {
  intake: { ar: 'الاستقبال والاستبيان', en: 'Intake & Questionnaire' },
  examination: { ar: 'الفحص السريري', en: 'Clinical Examination' },
  records: { ar: 'الصور والأشعة', en: 'Diagnostic Records' },
  analysis: { ar: 'القياسات والتحليلات', en: 'Measurements & Analysis' },
  planning: { ar: 'التشخيص وخطة العلاج', en: 'Diagnosis & Planning' },
  active_treatment: { ar: 'العلاج النشط', en: 'Active Treatment' },
  finishing: { ar: 'الإنهاء', en: 'Finishing' },
  retention: { ar: 'التثبيت والمتابعة', en: 'Retention & Follow-up' },
  completed: { ar: 'حالة منتهية', en: 'Completed' },
};

export const ROLE_LABELS: Record<UserRole, { ar: string; en: string }> = {
  doctor: { ar: 'أخصائي تقويم الأسنان', en: 'Orthodontist' },
  assistant: { ar: 'مساعد طبيب', en: 'Clinical Assistant' },
  reception: { ar: 'الاستقبال والمواعيد', en: 'Receptionist' },
  admin: { ar: 'مدير النظام', en: 'System Admin' },
};

export const REQUIRED_T0_VIEWS = [
  { key: 'extraoral_frontal', ar: 'وجهي أمامي (استرخاء)', en: 'Extraoral Frontal Rest' },
  { key: 'extraoral_smile', ar: 'وجهي ابتسامة', en: 'Extraoral Smile' },
  { key: 'extraoral_profile', ar: 'بروفايل جانبي', en: 'Extraoral Profile' },
  { key: 'intraoral_frontal', ar: 'داخل الفم أمامي', en: 'Intraoral Frontal' },
  { key: 'intraoral_right', ar: 'داخل الفم يمين', en: 'Intraoral Right' },
  { key: 'intraoral_left', ar: 'داخل الفم يسار', en: 'Intraoral Left' },
  { key: 'intraoral_upper', ar: 'إطباقي علوي', en: 'Upper Occlusal' },
  { key: 'intraoral_lower', ar: 'إطباقي سفلي', en: 'Lower Occlusal' },
  { key: 'panoramic_opg', ar: 'أشعة بانوراما (OPG)', en: 'Panoramic X-ray (OPG)' },
  { key: 'lateral_ceph', ar: 'سيفالومتري جانبي', en: 'Lateral Cephalogram' },
];

export const VIEW_TYPE_LABELS: Record<string, { ar: string; en: string }> = {
  extraoral_frontal: { ar: 'وجهي أمامي (استرخاء)', en: 'Extraoral Frontal' },
  extraoral_smile: { ar: 'صورة الابتسامة', en: 'Smile Photo' },
  extraoral_profile: { ar: 'صورة البروفايل الجانبي', en: 'Lateral Profile' },
  intraoral_frontal: { ar: 'داخل الفم أمامي', en: 'Intraoral Frontal' },
  intraoral_right: { ar: 'داخل الفم يمين', en: 'Intraoral Right' },
  intraoral_left: { ar: 'داخل الفم يسار', en: 'Intraoral Left' },
  intraoral_upper: { ar: 'إطباقي علوي', en: 'Upper Occlusal' },
  intraoral_lower: { ar: 'إطباقي سفلي', en: 'Lower Occlusal' },
  panoramic_opg: { ar: 'أشعة بانوراما (OPG)', en: 'Panoramic OPG' },
  lateral_ceph: { ar: 'سيفالومتري جانبي', en: 'Lateral Ceph' },
  cbct_dicom: { ar: 'أشعة مقطعية DICOM', en: 'CBCT / DICOM' },
  model_3d_stl: { ar: 'نموذج رقمي 3D', en: '3D Digital Model' },
  consent_doc: { ar: 'مستند موافقة', en: 'Consent Document' },
};

export function tr(lang: Language, ar: string, en: string): string {
  return lang === 'ar' ? ar : en;
}
