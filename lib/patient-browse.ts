/**
 * (PAT-1) قائمة المرضى الاحترافية — المرشّحات والترتيب كما تعرضها الشاشة، ويقرؤها الخادم.
 * كل مرشّح يعمل على **كل** المرضى في القاعدة (لا على الصفحة المحمّلة).
 */
export const PATIENT_LIST_FILTERS = {
  all: "الكل",
  debt: "عليهم مبالغ",
  alert: "تنبيه طبي",
  ortho: "تقويم نشط",
  no_next: "بلا موعد قادم",
  new_month: "جدد هذا الشهر",
  no_phone: "بلا جوال",
} as const;

export const PATIENT_LIST_SORTS = {
  recent: "الأحدث تسجيلًا",
  last_visit: "آخر زيارة",
  name: "الاسم",
} as const;

export type PatientListFilter = keyof typeof PATIENT_LIST_FILTERS;
export type PatientListSort = keyof typeof PATIENT_LIST_SORTS;

export function parseListFilter(value: string | null): PatientListFilter {
  return value && value in PATIENT_LIST_FILTERS ? (value as PatientListFilter) : "all";
}

export function parseListSort(value: string | null): PatientListSort {
  return value && value in PATIENT_LIST_SORTS ? (value as PatientListSort) : "recent";
}
