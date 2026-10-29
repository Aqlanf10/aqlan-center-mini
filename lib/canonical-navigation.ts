/** Browser-safe projection of the canonical workspace. A page appears here only when
 * its whole UI→HTTP→domain path admits canonical sessions (proved by the built
 * application journeys in __tests__/security-http/canonical-*.test.ts). Navigation
 * never grants: every route re-proves the exact capability server-side. */
import type { StaffCapability } from "./staff-capability-catalogue";

export type CanonicalRecordScopeView = "none" | "own" | "all";
export interface CanonicalPage {
 readonly href: string;
 readonly label: string;
 /** Any one of these grants shows the entry (owner sees all). Empty: no capability
  * gate beyond `record`. */
 readonly anyOf: readonly StaffCapability[];
 /** The page lists records: shown only when that record scope is not `none`. */
 readonly record?: "patient" | "appointment";
 /** Only this exact path: nested paths (for example a patient profile) are separate
  * pages that are registered only once their own routes are canonical. */
 readonly exact?: boolean;
 /** A parameterised page (for example one patient's file): matched by this pattern
  * instead of `href`, and never listed in the navigation. */
 readonly pattern?: RegExp;
 readonly description: string;
}
export interface CanonicalRecordScopes {
 readonly patientScope?: CanonicalRecordScopeView;
 readonly appointmentScope?: CanonicalRecordScopeView;
}
export const CANONICAL_PAGES: readonly CanonicalPage[] = Object.freeze([
 { href: "/visits", label: "قائمة اليوم", anyOf: [], record: "patient", exact: true, description: "المنتظرون والكراسي وتسجيل الوصول لمرضى نطاقك اليوم." },
 { href: "/patients", label: "المرضى", anyOf: [], record: "patient", exact: true, description: "البحث عن المرضى وتصفّح قائمتهم ضمن نطاق مرضاك المسموح." },
 { href: "/patients/[id]", label: "ملف المريض", anyOf: [], record: "patient", pattern: /^\/patients\/[1-9][0-9]{0,9}$/, description: "ملف مريضٍ ضمن نطاق مرضاك." },
 { href: "/staff-access", label: "صلاحيات الطاقم", anyOf: ["staff.view"], description: "دليل الطاقم وتعديل صلاحيات كل موظف بمراجعة وتدقيق." },
 { href: "/settings", label: "الإعدادات", anyOf: ["settings.view"], exact: true, description: "إعدادات العيادة والتشغيل والمالية؛ تعدّل ما تسمح به صلاحيتك فقط، وما للمالك يبقى للمالك." },
 { href: "/inventory/procurement", label: "طلبات الشراء", anyOf: ["inventory.requests.view"], description: "طلب مواد جديدة ومتابعة طلباتك أو طلبات المركز بحسب صلاحيتك." },
 { href: "/inventory/procurement/review", label: "اعتماد طلبات الشراء", anyOf: ["inventory.requests.approve"], description: "مراجعة قيم الطلبات واعتمادها أو رفضها باعتماد مستقل." },
 { href: "/inventory/procurement/operations", label: "أوامر الشراء والاستلام", anyOf: ["inventory.orders.view"], description: "إصدار أوامر الموردين، الاستلام والفحص، الحجر، ومطابقة فواتير الموردين." },
 { href: "/inventory/custody", label: "عهدة الأطباء", anyOf: ["inventory.custody.view"], description: "صرف المواد للعهدة، الاستلام، الاستهلاك، الجرد، التالف، والتسوية السنوية." },
 { href: "/inventory/procurement/setup", label: "تهيئة المواد والمواقع", anyOf: ["inventory.references.view"], description: "المواد ووحدات العبوات ومواقع التخزين وحدود اعتماد المشتريات." },
]);
/** Whether the current grants and record scopes show this page (owner: every page). */
export function canonicalPageAllowed(page: CanonicalPage, capabilities: readonly string[] | undefined, isOwner: boolean | undefined, scopes: CanonicalRecordScopes = {}): boolean {
 if (isOwner) return true;
 const granted = new Set(capabilities ?? []);
 if (page.anyOf.length > 0 && !page.anyOf.some(capability => granted.has(capability))) return false;
 if (page.record === "patient") return scopes.patientScope === "own" || scopes.patientScope === "all";
 if (page.record === "appointment") return scopes.appointmentScope === "own" || scopes.appointmentScope === "all";
 return page.anyOf.length > 0;
}
/** Navigation entries: allowed pages that are not parameterised. */
export function canonicalPagesFor(capabilities: readonly string[] | undefined, isOwner: boolean | undefined, scopes: CanonicalRecordScopes = {}): CanonicalPage[] {
 return CANONICAL_PAGES.filter(page => !page.pattern && canonicalPageAllowed(page, capabilities, isOwner, scopes));
}
/** The most specific registered page for a path (nested pages never inherit a parent's grant). */
export function canonicalPageFor(pathname: string): CanonicalPage | null {
 let best: CanonicalPage | null = null;
 for (const page of CANONICAL_PAGES) {
  if (page.pattern) { if (page.pattern.test(pathname)) return page; continue; }
  if ((pathname === page.href || (!page.exact && pathname.startsWith(`${page.href}/`))) && (!best || page.href.length > best.href.length)) best = page;
 }
 return best;
}
export function isCanonicalPage(pathname: string): boolean {
 return canonicalPageFor(pathname) !== null;
}
