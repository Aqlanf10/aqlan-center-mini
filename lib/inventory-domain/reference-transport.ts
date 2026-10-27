import "server-only";
import { getPool } from "../db";
import { withTransaction } from "../transactions";
import type { ReferenceIntent } from "../inventory-reference-protocol";
import {
  createReferenceSetupService,
  type ReferenceSetupAuthority,
} from "./reference-setup";
import { readFirstUseReadinessInTransaction } from "./first-use-readiness";
import { requireInventoryIntegration } from "./rollout";

/** Composition seam for the canonical opaque-session adapter. No environment,
 * request field, role name or UI flag can install an authority implementation. */
export function createReferenceTransport<Session>(
  authority: ReferenceSetupAuthority<Session>,
) {
  const service = createReferenceSetupService(authority);
  return {
    read: (session: Session, query: string, page: number) =>
      withTransaction(getPool(), (client) =>
        service.read(client, session, query, page),
      ),
    command: (
      session: Session,
      intent: ReferenceIntent,
      mode: "admit" | "execute" | "lookup" | "retire",
      reason?: string,
    ) =>
      withTransaction(getPool(), (client) =>
        service.command(client, session, intent, mode, reason),
      ),
    readiness: (session: Session) =>
      withTransaction(getPool(), async (client) => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        requireInventoryIntegration();
        // Central authorization may hold row locks. The reader itself writes
        // nothing; observation grants no subsequent mutation.
        await authority.revalidateInTransaction(
          client,
          session,
          "readiness.read",
        );
        return readFirstUseReadinessInTransaction(client);
      }),
  };
}

/** Deliberately unbound until the canonical authority owner supplies its adapter.
 * Do not wire the old supplier legacy-admin authenticator into this seam. */
export const referenceTransport = createReferenceTransport<unknown>({
  async revalidateInTransaction() {
    throw new Error("inventory_reference_authority_unavailable");
  },
  async verifyHistoricalBindingInTransaction() {
    throw new Error("inventory_reference_authority_unavailable");
  },
});
