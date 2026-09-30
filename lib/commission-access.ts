import { findUserByUsername } from "@/lib/db";
import { canDoctorViewClinicRevenue } from "@/lib/doctor-permissions";
import { canViewFinancialReports } from "@/lib/roles";
import type { SessionPayload } from "@/lib/auth";

/**
 * (COMM-DETAIL-1) من يرى العمولات وتفصيلها — قاعدة شاشة العمولات القائمة نفسها في مكانٍ واحد:
 *
 * - المدير والمحاسب: الجميع (والمحاسب يمرّ أولًا بقائمة السماح وصلاحية `viewCommissions`).
 * - الطبيب: يحتاج `canViewOwnCommissions`؛ ويرى الجميع فقط بمنحٍ صريح (إيراد العيادة أو
 *   حسابات الأطباء الآخرين)، وإلا فسطوره هو وحدها — وطبيبٌ بلا جهة مربوطة لا يرى شيئًا
 *   (لا «الكل» بالخطأ).
 * - غيرهم: ممنوع.
 */
export type CommissionViewer =
  | { kind: "all" }
  | { kind: "own"; partyId: number | null }
  | { kind: "denied"; status: 403; message: string };

export async function resolveCommissionViewer(session: SessionPayload): Promise<CommissionViewer> {
  if (canViewFinancialReports(session.role)) return { kind: "all" };
  if (session.role !== "doctor") {
    return { kind: "denied", status: 403, message: "تقرير العمولات للمدير أو الطبيب المصرح له." };
  }
  const user = await findUserByUsername(session.username).catch(() => null);
  if (!user?.permissions?.canViewOwnCommissions) {
    return { kind: "denied", status: 403, message: "غير مصرح لك بالاطلاع على العمولات والمستحقات." };
  }
  if (canDoctorViewClinicRevenue(user.permissions, session.role) || Boolean(user.permissions?.canViewOtherDoctorsAccounts)) {
    return { kind: "all" };
  }
  const partyId = user.partyId ?? (typeof session.partyId === "number" ? session.partyId : null);
  return { kind: "own", partyId };
}
