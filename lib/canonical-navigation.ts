/** Browser-safe projection of the canonical workspace. A page appears here only when
 * its whole UI→HTTP→domain path admits canonical sessions (accepted in
 * docs/security/staff-cutover/canonical-acceptance.json). Navigation never grants:
 * every route re-proves the exact capability server-side. */
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
]);
export function canonicalPagesFor(capabilities: readonly string[] | undefined, isOwner: boolean | undefined): CanonicalPage[] {
 const granted = new Set(capabilities ?? []);
 return CANONICAL_PAGES.filter(page => isOwner || page.anyOf.some(capability => granted.has(capability)));
}
export function isCanonicalPage(pathname: string): boolean {
 return CANONICAL_PAGES.some(page => pathname === page.href || pathname.startsWith(`${page.href}/`));
}
