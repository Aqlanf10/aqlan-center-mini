import { patientDestination, type PatientLocation } from "./patient-navigation";

/** Presentation registry only. patient-navigation remains the only URL/leave controller. */
export const WORKSPACE_SECTIONS = [
  { id: "summary", label: "نظرة عامة", group: "journey", eyebrow: "رحلة المريض", description: "الموعد والخطة والخطوة التالية من السجل الفعلي" },
  { id: "today", label: "زيارة اليوم", group: "journey", eyebrow: "العمل السريري", description: "التوثيق والإجراءات والتوقيع في زيارة واحدة" },
  { id: "plans", label: "خطط العلاج", group: "journey", eyebrow: "الخطة المشتركة", description: "بنود العلاج والاعتماديات والاتفاقات من مصدر واحد" },
  { id: "specialties", label: "التخصصات", group: "clinical", eyebrow: "مساحات العمل", description: "التخصصات المتاحة وحدود كل مسار بوضوح" },
  { id: "cases", label: "الحالات والمشاكل", group: "clinical", eyebrow: "السجل المشترك", description: "حالات متعددة وأطباء متعددون داخل ملف واحد" },
  { id: "chart", label: "المخطط السني", group: "clinical", eyebrow: "خريطة الأسنان", description: "حالة الأسنان والتوثيق السريري المحفوظ" },
  { id: "endo", label: "علاج الجذور", group: "clinical", eyebrow: "مساحة علاج الجذور", description: "التشخيص والقنوات والجلسات ضمن الحالة الأصلية" },
  { id: "perio", label: "فحص اللثة", group: "clinical", eyebrow: "مساحة علاج اللثة", description: "قياسات الفحص المحفوظة ضمن الزيارة والحالة والطبيب المحدد" },
  { id: "ortho", label: "التقويم والسيفالو", group: "clinical", eyebrow: "مساحة تقويم الأسنان", description: "الحالة والمراحل والسجلات والتحليل السيفالومتري" },
  { id: "files", label: "الأشعة والملفات", group: "records", eyebrow: "سجلات المريض", description: "صور ومستندات ملف المريض مع الروابط المحفوظة المتاحة" },
  { id: "lab", label: "المعمل والتركيبات", group: "records", eyebrow: "التنسيق مع المعمل", description: "الطلبات والتجارب والتسليم عبر الطلب الأصلي" },
  { id: "prescriptions", label: "الوصفات والتعليمات", group: "records", eyebrow: "العناية والمتابعة", description: "وصفات وموافقات وتعليمات باستخدام النماذج المعتمدة" },
  { id: "referrals", label: "الإحالات", group: "records", eyebrow: "التعاون السريري", description: "الإحالة والموعد والنتيجة من المسار المشترك" },
  { id: "timeline", label: "الخط الزمني", group: "records", eyebrow: "تاريخ موثّق", description: "الأحداث المحفوظة مع روابط إلى مصادرها" },
  { id: "account", label: "الحساب والدفعات", group: "management", eyebrow: "حساب المريض", description: "دفتر واحد وأرصدة منفصلة لكل عملة" },
  { id: "materials", label: "المستهلكات", group: "management", eyebrow: "مواد العلاج", description: "المواد المنصرفة المرتبطة بالزيارات" },
  { id: "identity", label: "البيانات والسلامة", group: "management", eyebrow: "هوية وأمان", description: "البيانات والتاريخ الطبي والعائلة والتواصل" },
  { id: "reports", label: "التقارير والطباعة", group: "management", eyebrow: "مخرجات السجل", description: "تقارير مباشرة من البيانات المحفوظة" },
] as const;
export type WorkspaceSection = (typeof WORKSPACE_SECTIONS)[number]["id"];
export const WORKSPACE_GROUPS = [
  { id: "journey", label: "المتابعة اليومية" }, { id: "clinical", label: "العلاج والتخصصات" },
  { id: "records", label: "السجلات والتنسيق" }, { id: "management", label: "إدارة الملف" },
] as const;
export function workspaceSection(location: PatientLocation): WorkspaceSection {
  return location.tab === "treatment" ? location.sub : location.tab;
}
export const workspaceDestination = (section: WorkspaceSection, current: PatientLocation) => patientDestination(section, current);
