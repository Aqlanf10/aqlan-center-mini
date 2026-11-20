import "server-only";
import type { SessionPayload } from "./auth";
import type { DbClient } from "./db";
import type { VerifiedDurableSession } from "./staff-durable-session";

// Unmounted managed-numbering contract. A durable handle proves signed
// transport only; it is not a staff or numbering operation admission.
export type BoundRequestSession = VerifiedDurableSession;

export async function readBoundRequestSession(): Promise<BoundRequestSession | null> {
  const { selectRequestStaffEnvelope } = await import("./staff-session-admission");
  const selected = await selectRequestStaffEnvelope();
  return selected.kind === "canonical" ? selected.handle : null;
}

export async function revalidateBoundRequestSession(
  _proof: BoundRequestSession, _client: DbClient,
): Promise<{ payload: SessionPayload; sessionBinding: string } | null> {
  // The standalone numbering adapter requires a legacy-shaped SessionPayload.
  // Never convert a durable canonical handle to that shape or fall back to a
  // signed legacy admin. A future canonical writer must prove the owner's
  // subject/enrollment under its lifecycle fence on the shared transaction.
  return null;
}
