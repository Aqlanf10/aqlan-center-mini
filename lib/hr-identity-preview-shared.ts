/** Safe, browser-visible identity evidence. No pay values, credentials or permission documents. */
export interface IdentityAccount { id: number; label: string; role: string; active: boolean; partyId: number | null }
export interface IdentityParty { id: number; label: string | null; kind: string; active: boolean }
export interface IdentityStaff {
  id: number; label: string; userId: number | null; workStatus: string;
  hireDateRecorded: boolean; salaryTermsComplete: boolean; contractKind: string;
}
export interface IdentityContractLink { id: number; staffId: number; partyId: number | null; status: string }
export interface IdentityPayrollLink { staffId: number; partyId: number }
export interface IdentitySources {
  accounts: IdentityAccount[]; parties: IdentityParty[]; staff: IdentityStaff[];
  contracts: IdentityContractLink[]; payrollLinks: IdentityPayrollLink[];
}
export interface IdentityDecision {
  userIds: number[]; partyIds: number[]; staffId: number | null; confirmedSamePerson: true;
}
export type IdentityAction = 'create' | 'link' | 'skip' | 'conflict';
export const IDENTITY_ACTION_LABEL: Record<IdentityAction, string> = {
  create: 'إنشاء مقترح', link: 'ربط مقترح', skip: 'إبقاء كما هو', conflict: 'تعارض يحتاج مراجعة',
};
export const IDENTITY_REASON_LABEL = {
  existing_staff: 'يوجد ملف HR؛ تبقى روابطه الحالية محفوظة.',
  employment_unconfirmed: 'الحساب أو الجهة لا يثبتان وحدهما علاقة عمل.',
  explicit_preview: 'تجميع بمعرفات صريحة أكده المدير لهذه المعاينة فقط؛ غير محفوظ.',
  missing_staff: 'لا يوجد ملف HR موثق لهذه الهوية.',
  missing_hire_date: 'تاريخ التوظيف غير مسجل؛ لا يُستنتج من إنشاء الحساب.',
  missing_contract: 'لا يوجد عقد معتمد أو نشط؛ لا تُفترض شروط تعاقد.',
  incomplete_salary: 'حقول شروط الراتب غير مكتملة.',
  inactive_account: 'يوجد حساب معطل؛ يبقى معطلًا ولا يمنح الربط وصولًا.',
  inactive_party: 'الجهة غير نشطة؛ يحتاج استخدامها لاحقًا مراجعة مستقلة.',
  missing_source: 'معرف مصدر أو رابط مخزن لا يشير إلى سجل موجود.',
  excluded_party: 'الجهة ليست طبيبًا أو موظفًا؛ لا تدخل في تحويل HR.',
  shared_party: 'الجهة مرتبطة بحسابات أخرى؛ لم يُؤكد أنها للشخص نفسه.',
  different_parties: 'مصادر الربط تشير إلى جهات مالية مختلفة؛ لا اختيار تلقائي.',
  different_staff: 'الحسابات مرتبطة بملفات HR أخرى أو متعددة؛ لا دمج.',
  duplicate_selection: 'المصدر مختار في أكثر من قرار ضمن المعاينة.',
  select_existing_staff: 'يوجد ملف HR؛ يلزم اختياره صراحة بدل اقتراح ملف جديد.',
} as const;
export type IdentityReason = keyof typeof IDENTITY_REASON_LABEL;
export interface IdentityCandidate {
  key: string; action: IdentityAction; userIds: number[]; partyIds: number[]; staffIds: number[];
  reasons: IdentityReason[]; unknowns: IdentityReason[]; explicit: boolean;
}
export interface IdentityPreview {
  version: 1; readOnly: true; sourceDigest: string; previewDigest: string;
  sources: IdentitySources; candidates: IdentityCandidate[];
  counts: Record<IdentityAction, number>;
}
