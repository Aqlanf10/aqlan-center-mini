import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
// The held commands must refuse before any database work: a connection attempt is itself a failure.
vi.mock("../lib/db", () => ({ getPool: () => ({ connect: () => { throw new Error("database touched"); }, query: () => { throw new Error("database touched"); } }) }));
import { CanonicalCephCreateRefusal, commandCanonicalCephCreate } from "../lib/canonical-ceph-create-command";
import { CanonicalCephCopyRefusal, commandCanonicalCephCopy } from "../lib/canonical-ceph-copy-command";
import { CanonicalCephDiscardRefusal, commandCanonicalCephDiscard } from "../lib/canonical-ceph-discard-command";
import { CanonicalCephCompleteRefusal, commandCanonicalCephComplete } from "../lib/canonical-ceph-complete-command";
import { CanonicalCephEditRefusal, commandCanonicalCephEdit } from "../lib/canonical-ceph-edit-command";
import type { VerifiedDurableSession } from "../lib/staff-durable-session";

/**
 * Integration branch (2026-11-12): the canonical ceph writers were built on the earlier completion
 * contract. Staging's protected writers own every ceph write until these are re-aligned with the
 * snapshot/sources/provenance contract. A valid request is held with 409; malformed input stays 400.
 */
const session = {} as VerifiedDurableSession;
const pool = { connect: () => { throw new Error("database touched"); } } as never;
const expectedVersion = "a".repeat(64);
const diagnosis = { skeletal: null, dental: null, softTissue: null, note: null, finalDx: "SYN draft" };
// Each body is accepted by that command's own parser (see canonical-ceph-*-command.test.ts).
const commands = [
  ["create", commandCanonicalCephCreate, CanonicalCephCreateRefusal, { documentId: 2 }],
  ["copy", commandCanonicalCephCopy, CanonicalCephCopyRefusal, {}],
  ["discard", commandCanonicalCephDiscard, CanonicalCephDiscardRefusal, { expectedVersion, note: "SYN note" }],
  ["complete", commandCanonicalCephComplete, CanonicalCephCompleteRefusal, { expectedVersion }],
  ["edit", commandCanonicalCephEdit, CanonicalCephEditRefusal, { expectedVersion, diagnosis }],
] as const;

describe("canonical ceph writes are held until contract alignment", () => {
  it.each(commands)("%s still refuses a malformed request with 400 before the hold", async (_name, command, Refusal) => {
    const error = await command(session, "0", null, pool).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Refusal);
    expect((error as { status: number }).status).toBe(400);
  });
  it.each(commands)("%s holds a well-formed request with 409 and never touches the database", async (_name, command, Refusal, body) => {
    const error = await command(session, "1", body, pool).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Refusal);
    expect(error).toMatchObject({ code: "ceph_contract_alignment_pending", status: 409 });
    expect((error as Error).message).toContain("لم يُكتب شيء");
  });
});
