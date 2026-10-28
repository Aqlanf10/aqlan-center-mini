/** Browser-safe projection of the canonical workspace. A page appears here only when
 * its whole UI→HTTP→domain path admits canonical sessions (proved by the built
 * application journeys in __tests__/security-http/canonical-*.test.ts). Navigation
 * never grants: every route re-proves the exact capability server-side. */
import type { StaffCapability } from "./staff-capability-catalogue";

export interface CanonicalPage {
 readonly href: string;
 readonly label: string;
 /** Any one of these grants shows the entry (owner sees all). */
 readonly anyOf: readonly StaffCapability[];
 readonly description: string;
}
export const CANONICAL_PAGES: readonly CanonicalPage[] = Object.freeze([
 { href: "/staff-access", label: "صلاحيات الطاقم", anyOf: ["staff.view"], description: "دليل الطاقم وتعديل صلاحيات كل موظف بمراجعة وتدقيق." },
 { href: "/inventory/procurement", label: "طلبات الشراء", anyOf: ["inventory.requests.view"], description: "طلب مواد جديدة ومتابعة طلباتك أو طلبات المركز بحسب صلاحيتك." },
 { href: "/inventory/procurement/review", label: "اعتماد طلبات الشراء", anyOf: ["inventory.requests.approve"], description: "مراجعة قيم الطلبات واعتمادها أو رفضها باعتماد مستقل." },
 { href: "/inventory/procurement/operations", label: "أوامر الشراء والاستلام", anyOf: ["inventory.orders.view"], description: "إصدار أوامر الموردين، الاستلام والفحص، الحجر، ومطابقة فواتير الموردين." },
 { href: "/inventory/custody", label: "عهدة الأطباء", anyOf: ["inventory.custody.view"], description: "صرف المواد للعهدة، الاستلام، الاستهلاك، الجرد، التالف، والتسوية السنوية." },
 { href: "/inventory/procurement/setup", label: "تهيئة المواد والمواقع", anyOf: ["inventory.references.view"], description: "المواد ووحدات العبوات ومواقع التخزين وحدود اعتماد المشتريات." },
]);
export function canonicalPagesFor(capabilities: readonly string[] | undefined, isOwner: boolean | undefined): CanonicalPage[] {
 const granted = new Set(capabilities ?? []);
 return CANONICAL_PAGES.filter(page => isOwner || page.anyOf.some(capability => granted.has(capability)));
}
/** The most specific registered page for a path (nested pages never inherit a parent's grant). */
export function canonicalPageFor(pathname: string): CanonicalPage | null {
 let best: CanonicalPage | null = null;
 for (const page of CANONICAL_PAGES) {
  if ((pathname === page.href || pathname.startsWith(`${page.href}/`)) && (!best || page.href.length > best.href.length)) best = page;
 }
 return best;
}
export function isCanonicalPage(pathname: string): boolean {
 return canonicalPageFor(pathname) !== null;
}
