import { HTTP_PERMISSIONS } from "./http-permissions";
import { canActOnReferral } from "./referrals";
import { isRole } from "./roles";

/** Internal referral authority is used only to project a capability, never sent to the client. */
export function projectPlannedVisitRebooking<T extends {
  canRebook: boolean;
  rebookBlockedReason: string | null;
  rebookHasReferral: boolean;
  rebookReferralReceiverId: number | null;
}>(visit: T, actor: { role: string; partyId?: number | null }) {
  const { rebookHasReferral, rebookReferralReceiverId, ...visible } = visit;
  const permission = HTTP_PERMISSIONS["/api/planned-visits/[id]/rebook"].POST;
  const roleAllowed = isRole(actor.role) && Array.isArray(permission) && permission.includes(actor.role);
  const referralAllowed = !rebookHasReferral || canActOnReferral({ action: "schedule",
    role: actor.role, actorPartyId: actor.partyId ?? null, referringPartyId: null,
    receivingPartyId: rebookReferralReceiverId,
  });
  return {
    ...visible,
    canRebook: visible.canRebook === true && roleAllowed && referralAllowed,
    rebookBlockedReason: visible.canRebook && (!roleAllowed || !referralAllowed)
      ? "إعادة حجز هذه الجلسة متاحة للاستقبال أو الطبيب المخوّل فقط."
      : visible.rebookBlockedReason,
  };
}
