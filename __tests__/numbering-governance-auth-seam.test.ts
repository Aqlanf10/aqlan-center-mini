import { createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, legacySessionEvidence, signDurableSessionClaims } from "../lib/auth";
import type { DbClient } from "../lib/db";
import { readBoundRequestSession, readSessionPayload, revalidateBoundRequestSession, type BoundRequestSession } from "../lib/session";
import { STAFF_AUTHORIZATION_POLICY_VERSION } from "../lib/staff-capability-catalogue";
import { boundOwnerRelationship, ownerContextFromTrustedBinding, type TrustedOwnerContext } from "../lib/staff-capabilities";

const transport = vi.hoisted(() => ({ cookie: "", authorization: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => transport.cookie ? { value: transport.cookie } : undefined }),
  headers: async () => new Headers(transport.authorization ? { authorization: transport.authorization } : {}),
}));

const durable = (expiresAt = Date.now() + 60_000) => signDurableSessionClaims({
  userId: 12, username: "synthetic-durable", expiresAt,
  durableIdentity: {
    schemaVersion: 2, policyVersion: STAFF_AUTHORIZATION_POLICY_VERSION,
    realmId: "11111111-1111-4111-8111-111111111111", subjectId: "22222222-2222-4222-8222-222222222222",
    generationId: "33333333-3333-4333-8333-333333333333", registryRevision: "4", controlEpoch: "2", accountEpoch: "3",
    permissionRevision: 1, credentialVersion: "a".repeat(43), provider: null,
  },
});
const legacy = () => createSessionToken({
  userId: 52, username: "synthetic-legacy", role: "admin", expiresAt: Date.now() + 60_000, credentialVersion: "synthetic",
});
function signedMalformedCanonical(): string {
  const body = Buffer.from(JSON.stringify({
    userId: 12, username: "synthetic-durable", expiresAt: Date.now() + 60_000, durableIdentity: { schemaVersion: 2 },
  })).toString("base64url");
  return body + "." + createHmac("sha256", process.env.SESSION_SECRET!).update(body).digest("base64url");
}

beforeEach(() => {
  transport.cookie = ""; transport.authorization = "";
  vi.stubEnv("SESSION_SECRET", randomBytes(32).toString("hex"));
});
afterEach(() => vi.unstubAllEnvs());

describe("combined dormant numbering uses the canonical selection without admission", () => {
  it("preserves legacy evidence for the existing route and refuses legacy admin as numbering transport", async () => {
    transport.cookie = legacy();
    const payload = await readSessionPayload();
    expect(payload).toMatchObject({ userId: 52, role: "admin" });
    expect(payload && legacySessionEvidence(payload)).toBeTruthy();
    expect(await readBoundRequestSession()).toBeNull();
    transport.cookie = "";
    transport.authorization = "Bearer " + legacy();
    expect(await readBoundRequestSession()).toBeNull();
  });
  it("selects genuine durable cookie without downgrading to a pending legacy Bearer", async () => {
    transport.cookie = durable();
    transport.authorization = "Bearer " + legacy();
    expect(await readSessionPayload()).toBeNull();
    const proof = await readBoundRequestSession();
    expect(proof).not.toBeNull();
    expect(Object.keys(proof ?? {})).toEqual([]);
    const query = vi.fn();
    const client = { query } as unknown as DbClient;
    expect(await revalidateBoundRequestSession(proof!, client)).toBeNull();
    expect(await revalidateBoundRequestSession({ ...proof } as BoundRequestSession, client)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
  it("never downgrades a selected signed malformed or expired canonical cookie", async () => {
    transport.authorization = "Bearer " + legacy();
    for (const selected of [signedMalformedCanonical(), durable(Date.now() - 5_000)]) {
      transport.cookie = selected;
      expect(await readSessionPayload()).toBeNull();
      expect(await readBoundRequestSession()).toBeNull();
    }
  });
  it("uses canonical Bearer only when the common selection would choose it", async () => {
    transport.authorization = "Bearer " + durable();
    transport.cookie = legacy();
    expect(await readBoundRequestSession()).toBeNull();
    transport.cookie = "invalid.token";
    expect(await readBoundRequestSession()).not.toBeNull();
  });
  it("reports owner relationship only for opaque context issued at the trusted boundary", () => {
    const context = ownerContextFromTrustedBinding({ ownerUserId: 12, bindingVersion: "synthetic-reviewed" });
    expect(boundOwnerRelationship(context, 12)).toBe("owner");
    expect(boundOwnerRelationship(context, 52)).toBe("other");
    expect(boundOwnerRelationship({ ...context } as TrustedOwnerContext, 12)).toBeNull();
    expect(boundOwnerRelationship(context, 0)).toBeNull();
  });
});
