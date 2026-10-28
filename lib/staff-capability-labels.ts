/** Browser-safe Arabic presentation of the canonical capability catalogue. Labels
 * never grant anything; the server decides every operation from the stored document. */
import { STAFF_CAPABILITIES, STAFF_CAPABILITY_PREREQUISITES, type StaffCapability, type StaffRecordScope } from "./staff-capability-catalogue";

export const STAFF_CAPABILITY_GROUPS = [
 { key: "patients", label: "المرضى" },
 { key: "clinical", label: "السريري" },
 { key: "appointments", label: "المواعيد" },
 { key: "finance", label: "المالية" },
 { key: "reports", label: "التقارير" },
 { key: "inventory", label: "المخزون والمشتريات" },
 { key: "staff", label: "الطاقم" },
 { key: "settings", label: "الإعدادات" },
 { key: "audit", label: "سجل التدقيق" },
] as const;
export type StaffCapabilityGroup = typeof STAFF_CAPABILITY_GROUPS[number]["key"];

export const STAFF_CAPABILITY_LABELS: Readonly<Record<StaffCapability, string>> = Object.freeze({
 "patients.create": "إضافة مريض",
 "patients.edit": "تعديل بيانات المريض",
 "patients.delete": "حذف/أرشفة مريض",
 "patients.export": "تصدير بيانات المرضى",
 "clinical.plans.view": "عرض خطط العلاج",
 "clinical.plans.edit": "تعديل خطط العلاج",
 "clinical.xrays.view": "عرض الأشعة والصور",
 "clinical.xrays.upload": "رفع الأشعة والصور",
 "clinical.visits.document": "توثيق الزيارة السريرية",
 "clinical.visits.sign": "توقيع الزيارة",
 "appointments.create": "حجز موعد",
 "appointments.edit": "تعديل موعد",
 "appointments.cancel": "إلغاء موعد",
 "appointments.override-capacity": "تجاوز سعة الجدول",
 "finance.invoices.view": "عرض الفواتير",
 "finance.invoices.create": "إنشاء فاتورة",
 "finance.invoices.cancel": "إلغاء فاتورة",
 "finance.invoices.mark-paid": "تعليم الفاتورة مدفوعة",
 "finance.payments.view": "عرض المدفوعات",
 "finance.payments.collect": "تحصيل دفعة",
 "finance.payments.refund": "استرداد دفعة",
 "finance.payments.void": "إبطال دفعة",
 "finance.expenses.view": "عرض المصروفات",
 "finance.expenses.create": "تسجيل مصروف",
 "finance.expenses.void": "إبطال مصروف",
 "finance.shifts.view": "عرض ورديات الصندوق",
 "finance.shifts.operate": "فتح وإغلاق وردية الصندوق",
 "finance.patient-ledger.view": "عرض كشف حساب المريض",
 "finance.service-prices.view": "عرض أسعار الخدمات",
 "finance.service-prices.edit": "تعديل أسعار الخدمات",
 "finance.cost-prices.view": "عرض أسعار التكلفة",
 "finance.discounts.apply": "تطبيق خصم",
 "finance.discounts.override": "تجاوز حد الخصم",
 "finance.price-increases.apply": "تطبيق زيادة سعر",
 "finance.commissions.view-own": "عرض مستحقاتي (العمولة الشخصية)",
 "finance.commissions.view-all": "عرض عمولات جميع الأطباء",
 "finance.commissions.manage-rates": "إدارة نسب العمولات",
 "finance.revenue.view": "عرض الإيرادات",
 "finance.profits.view": "عرض الأرباح",
 "finance.suppliers.view": "عرض حسابات الموردين",
 "finance.reconciliation.view": "عرض المطابقات",
 "finance.export": "تصدير البيانات المالية",
 "reports.operational.view": "التقارير التشغيلية",
 "reports.financial.view": "التقارير المالية",
 "reports.clinical.view": "التقارير السريرية",
 "reports.export": "تصدير التقارير",
 "inventory.references.view": "عرض أصناف ووحدات ومواقع المخزون",
 "inventory.items.create": "إضافة صنف مخزون",
 "inventory.units.revise": "تعديل وحدات الصنف",
 "inventory.locations.create": "إضافة موقع تخزين",
 "staff.view": "عرض دليل الطاقم",
 "staff.profile.edit": "تعديل بيانات موظف",
 "staff.accounts.create": "إنشاء حساب موظف",
 "staff.accounts.disable": "تعطيل حساب موظف",
 "staff.permissions.edit": "إدارة صلاحيات الطاقم",
 "settings.view": "عرض الإعدادات",
 "settings.operational.edit": "تعديل الإعدادات التشغيلية",
 "settings.finance.edit": "تعديل الإعدادات المالية",
 "audit.view": "عرض سجل التدقيق",
 "audit.export": "تصدير سجل التدقيق",
});
export function staffCapabilityGroup(capability: StaffCapability): StaffCapabilityGroup {
 const prefix = capability.split(".")[0];
 return (STAFF_CAPABILITY_GROUPS.some(group => group.key === prefix) ? prefix : "settings") as StaffCapabilityGroup;
}
export const STAFF_SCOPE_LABELS: Readonly<Record<StaffRecordScope, string>> = Object.freeze({
 none: "لا شيء",
 own: "مرضاه/مواعيده فقط (حسب الطبيب المرتبط)",
 all: "الجميع",
});
/** Granting a capability also grants its prerequisites; removing a prerequisite removes dependants. */
export function toggleStaffCapability(grants: ReadonlySet<StaffCapability>, capability: StaffCapability, on: boolean): Set<StaffCapability> {
 const next = new Set(grants);
 if (on) {
  const add = (c: StaffCapability) => { next.add(c); for (const required of STAFF_CAPABILITY_PREREQUISITES[c] ?? []) add(required); };
  add(capability);
 } else {
  const remove = (c: StaffCapability) => {
   next.delete(c);
   for (const dependant of STAFF_CAPABILITIES) if (next.has(dependant) && (STAFF_CAPABILITY_PREREQUISITES[dependant] ?? []).includes(c)) remove(dependant);
  };
  remove(capability);
 }
 return next;
}
