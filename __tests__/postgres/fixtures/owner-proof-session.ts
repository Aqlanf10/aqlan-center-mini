import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { getPool } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { withTransaction } from "../../../lib/transactions";

// Local rehearsal only. Scope and the redeemer connection belong to the server.
// The caller can submit only a code; account and credential come from the normal login.
export function ownerProofForLogin(redeemer: Pick<Pool, "query">, clinic: string, environment: string) {
  function withAccount<T>(work: (id: number, credential: string) => Promise<T>) {
    return withTransaction(getPool(), async (client) => {
      const account = await requireSession(client);
      if (account?.role !== "admin" || !account.credentialVersion) return null;
      return work(account.userId, account.credentialVersion);
    });
  }

  return {
    async redeem(code: string): Promise<boolean> {
      if (typeof code !== "string" || !/^[a-f0-9]{64}$/.test(code)) return false;
      const accepted = await withAccount(async (id, credential) => {
        const result = await redeemer.query<{ accepted: boolean }>(
          "SELECT owner_proof.redeem($1,$2,$3,$4,$5) AS accepted",
          [clinic, environment, id, credential, Buffer.from(code, "hex")],
        );
        return result.rows[0].accepted;
      });
      return accepted === true;
    },

    async current() {
      return withAccount(async (id, credential) => {
        const result = await redeemer.query<{ version: string | null }>(
          "SELECT owner_proof.current_binding($1,$2,$3,$4)::text AS version",
          [clinic, environment, id, credential],
        );
        const version = result.rows[0].version;
        if (version === null) return null;
        // Bind the canonical capability fingerprint to this authority scope and generation.
        const bindingVersion = createHash("sha256").update(JSON.stringify([clinic, environment, version])).digest("hex");
        return { ownerUserId: id, bindingVersion };
      });
    },
  };
}
