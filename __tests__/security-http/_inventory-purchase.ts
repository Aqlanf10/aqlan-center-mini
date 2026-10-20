import { randomUUID } from "node:crypto";
import { authedGet, authedMutation } from "./_server";

/** Synthetic fixtures use the same fail-closed purchase protocol as the UI. */
export async function seededInventoryPurchase(
  itemId: number, session: Parameters<typeof authedMutation>[1], purchase: Record<string, unknown>,
) {
  const identity = await authedGet("/api/auth/me", session);
  if (!identity.ok) throw new Error("Synthetic purchase actor is not authenticated");
  const actor = await identity.json();
  if (!Number.isInteger(actor.id) || typeof actor.username !== "string") throw new Error("Missing synthetic actor identity");
  return authedMutation(`/api/inventory/${itemId}/movements`, session, "POST",
    JSON.stringify({ protocol: "inventory-purchase-v1", purchase }),
    { "Idempotency-Key": randomUUID(), "X-Purchase-Actor": encodeURIComponent(actor.username), "X-Purchase-Actor-Id": String(actor.id) });
}
