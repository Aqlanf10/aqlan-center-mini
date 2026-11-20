import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { parseTarBytes } from "../lib/restore/archive";
import { admitManagedNumberingCheckpoint, encodeManagedNumberingCheckpoint, encodeManagedNumberingSidecar,
  type ManagedNumberingPayload } from "../lib/patient-numbering-recovery-v2";
import { tarHeader, tarPadding, tarEnd } from "../lib/tar";
import {
  admitNumberingRecovery, encodeNumberingRecovery, NUMBERING_RECOVERY_MAX_BYTES,
  type NumberingRecoveryPayload, type NumberingRecoveryManifest,
} from "../lib/patient-numbering-recovery";

const lineage = "ba3f640b-1234-4b62-9c16-d9f49f5c8d01";
const other = "ba3f640b-1234-4b62-9c16-d9f49f5c8d02";
const actor = "9007199254740993";
const before = "1:P:B:1:0:0:1", after = "2:B:B:37:0:0:1";
function sample(): NumberingRecoveryPayload {
  return {
    version: 1, lineage, activePrefix: "B", configRevision: "2",
    counters: [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((prefix) => ({
      prefix, lastValue: prefix === "P" ? "999999999999999999" : prefix === "B" ? "37" : "1",
      isCalled: prefix === "P", historicalThrough: prefix === "P" ? "123" : "0", historyComplete: true,
    })),
    auditSequence: { lastValue: "4", isCalled: true },
    retiredAliases: [{ number: "P-00000123", patientId: actor }, { number: "P-00123", patientId: actor }],
    audit: [{
      id: "2", actor, reason: "Synthetic check",
      beforeState: { prefix: "B", allocatedThrough: "0", pendingNext: "1", historicalThrough: "0", historyComplete: true, revision: before },
      afterState: { prefix: "B", allocatedThrough: "0", pendingNext: "37", historicalThrough: "0", historyComplete: true, revision: after },
    }],
    receipts: [{
      actor, request: "synthetic_request_000001",
      intent: JSON.stringify(["B", "37", before, "Synthetic check"]),
      result: { prefix: "B", next: "37", preview: "B-00037", revision: after },
    }],
  };
}
const authority = (manifest: NumberingRecoveryManifest) => ({
  expectedLineage: lineage,
  readCurrent: vi.fn(async () => ({ version: 1 as const, lineage, stateSha256: manifest.sha256 })),
});

it("round-trips exact pending values, high-water, stable aliases and paired audit/receipts", async () => {
  const state = sample();
  const reversed = { ...state, counters: [...state.counters].reverse(), retiredAliases: [...state.retiredAliases].reverse() };
  const encoded = encodeNumberingRecovery(state);
  expect(encodeNumberingRecovery(reversed)).toEqual(encoded);
  const source = authority(encoded.manifest);
  expect(await admitNumberingRecovery(encoded.bytes, encoded.manifest, source)).toEqual({ ok: true, payload: state });
  expect(source.readCurrent).toHaveBeenCalledExactlyOnceWith(lineage);
});
it("refuses missing or unavailable independent evidence", async () => {
  const { bytes, manifest } = encodeNumberingRecovery(sample());
  const refused = { ok: false, reason: "trusted-witness-unavailable" };
  expect(await admitNumberingRecovery(bytes, manifest, null)).toEqual(refused);
  expect(await admitNumberingRecovery(bytes, manifest, {
    expectedLineage: lineage, readCurrent: async () => null,
  })).toEqual(refused);
  expect(await admitNumberingRecovery(bytes, manifest, {
    expectedLineage: lineage, readCurrent: async () => { throw new Error("synthetic unavailable"); },
  })).toEqual(refused);
});
it("refuses both old and apparently higher snapshots unless exact authoritative state agrees", async () => {
  const state = sample();
  const original = encodeNumberingRecovery(state);
  const witness = authority(original.manifest);
  const counter = state.counters[1];
  for (const next of ["38", "900000"]) {
    counter.lastValue = next;
    const changed = encodeNumberingRecovery(state);
    expect(await admitNumberingRecovery(changed.bytes, changed.manifest, witness))
      .toEqual({ ok: false, reason: "freshness-mismatch" });
  }
});
it("does not let an archive choose which lineage's authority to read", async () => {
  const { bytes, manifest } = encodeNumberingRecovery({ ...sample(), lineage: other });
  const witness = authority(manifest);
  expect(await admitNumberingRecovery(bytes, manifest, witness)).toEqual({ ok: false, reason: "freshness-mismatch" });
  expect(witness.readCurrent).not.toHaveBeenCalled();
});
it.each([
  (d: NumberingRecoveryPayload) => { d.counters.pop(); },
  (d: NumberingRecoveryPayload) => { d.counters[25] = d.counters[0]; },
  (d: NumberingRecoveryPayload) => { Object.assign(d.counters[0], { historyComplete: false }); },
  (d: NumberingRecoveryPayload) => { Object.assign(d.counters[0], { lastValue: "9007199254740993000" }); },
  (d: NumberingRecoveryPayload) => { Object.assign(d.counters[0], { historicalThrough: "1" }); },
  (d: NumberingRecoveryPayload) => { d.retiredAliases[1].patientId = "2"; },
  (d: NumberingRecoveryPayload) => { d.retiredAliases[1].number = "P-00124"; },
  (d: NumberingRecoveryPayload) => { Reflect.deleteProperty(d, "retiredAliases"); },
  (d: NumberingRecoveryPayload) => { d.audit = []; d.receipts = []; },
  (d: NumberingRecoveryPayload) => { d.audit = []; },
  (d: NumberingRecoveryPayload) => { d.receipts[0].result.preview = "B-00038"; },
  (d: NumberingRecoveryPayload) => { d.auditSequence.isCalled = false; d.auditSequence.lastValue = "2"; },
  (d: NumberingRecoveryPayload) => { d.activePrefix = "C"; },
  (d: NumberingRecoveryPayload) => { Object.assign(d, { sql: "not a data field" }); },
])("rejects partial, inconsistent or extra projection fields", (mutate) => {
  const state = sample();
  mutate(state);
  expect(() => encodeNumberingRecovery(state)).toThrow();
});
it("rejects an internally consistent audit pair that has rewound a prior reservation for the same prefix", () => {
  const state = sample();
  state.configRevision = "3";
  const secondBefore = "2:B:B:10:0:0:1", secondAfter = "3:B:B:40:0:0:1";
  state.counters[1].lastValue = "40";
  state.audit.push({
    ...state.audit[0], id: "3",
    beforeState: { ...state.audit[0].beforeState, pendingNext: "10", revision: secondBefore },
    afterState: { ...state.audit[0].afterState, pendingNext: "40", revision: secondAfter },
  });
  state.receipts.push({
    ...state.receipts[0], request: "synthetic_request_000002",
    intent: JSON.stringify(["B", "40", secondBefore, "Synthetic check"]),
    result: { prefix: "B", next: "40", preview: "B-00040", revision: secondAfter },
  });
  expect(() => encodeNumberingRecovery(state)).toThrow();
});
it("rejects noncanonical bytes even with recomputed untrusted manifest hashes", async () => {
  const { bytes, manifest } = encodeNumberingRecovery(sample());
  const canonical = Buffer.from(bytes).toString("utf8");
  for (const body of [
    Buffer.from(" " + canonical),
    Buffer.from(canonical.replace('"version":1', '"version":1,"version":1')),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
    Buffer.concat([Buffer.from([0xff]), bytes]),
    Buffer.alloc(NUMBERING_RECOVERY_MAX_BYTES + 1, " "),
  ]) {
    const changed = { ...manifest, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length };
    const witness = authority(changed);
    expect(await admitNumberingRecovery(body, changed, witness)).toEqual({ ok: false, reason: "invalid-payload" });
    expect(witness.readCurrent).not.toHaveBeenCalled();
  }
});
it("requires the exact manifest entry/hash/version/byte count", async () => {
  const { bytes, manifest } = encodeNumberingRecovery(sample());
  for (const changed of [
    { ...manifest, entry: "database.sql" }, { ...manifest, version: 2 },
    { ...manifest, bytes: manifest.bytes + 1 }, { ...manifest, sha256: "1".repeat(64) },
    { ...manifest, extra: "not allowed" },
  ]) expect(await admitNumberingRecovery(bytes, changed, authority(manifest))).toEqual({ ok: false, reason: "invalid-payload" });
});


it("transports exact sidecar and descriptor through real TAR bytes without a SQL entry", async () => {
  const { bytes, manifest } = encodeNumberingRecovery(sample());
  const fixed = new Date("2026-01-01T00:00:00Z");
  const manifestBytes = Buffer.from(JSON.stringify({ numberingRecovery: manifest }));
  const archive = parseTarBytes(Buffer.concat([
    tarHeader(manifest.entry, bytes.byteLength, fixed), bytes, tarPadding(bytes.byteLength),
    tarHeader("manifest.json", manifestBytes.byteLength, fixed), manifestBytes, tarPadding(manifestBytes.byteLength),
    tarEnd(),
  ]));
  expect(archive.truncated).toBe(false);
  expect(archive.order).toEqual([manifest.entry, "manifest.json"]);
  const decodedManifest = JSON.parse(Buffer.from(archive.entries.get("manifest.json")!.data).toString()).numberingRecovery;
  const payload = archive.entries.get(manifest.entry)!.data;
  expect(await admitNumberingRecovery(payload, decodedManifest, authority(manifest))).toEqual({ ok: true, payload: sample() });
});

const attachment = Buffer.from('synthetic application checkpoint A');
const v2 = (): ManagedNumberingPayload => {
  const numbering = sample();
  for (const audit of numbering.audit) audit.actor = "99";
  for (const receipt of numbering.receipts) receipt.actor = "99";
  return {
    version: 2, managed: { phase: "MANAGED", lineage, generation: "3" }, numbering,
    dispositions: [
      { lineage, enrollment: "synthetic_enrollment_01", actor: "99", request: "synthetic_request_000001",
        expiresAtMs: "1500000000111", state: "committed" },
      { lineage, enrollment: "synthetic_enrollment_01", actor: "99", request: "synthetic_request_000002",
        expiresAtMs: "1500000000222", state: "issued" },
    ],
  };
};
const hashBytes = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function currentV2(state: ManagedNumberingPayload, tar: Buffer) {
  const { lineage, generation } = state.managed;
  const stateSha256 = encodeManagedNumberingSidecar(state).manifest.sha256, archiveSha256 = hashBytes(tar);
  return { expectedLineage: lineage, expectedGeneration: generation, readCurrent: vi.fn(async () => ({
    version: 2 as const, lineage, generation, stateSha256, archiveSha256,
  })) };
}
it("v2 canonicalizes literal generations and opaque lifecycle metadata; requires two independently witnessed digests", async () => {
  const state = v2(), exact = encodeManagedNumberingCheckpoint(state, attachment);
  expect(encodeManagedNumberingCheckpoint({ ...state, dispositions: [...state.dispositions].reverse() }, attachment)).toEqual(exact);
  expect(await admitManagedNumberingCheckpoint(exact, null)).toEqual({ ok: false, reason: "trusted-witness-unavailable" });
  const witness = currentV2(state, exact);
  expect(await admitManagedNumberingCheckpoint(exact, witness)).toEqual({ ok: true, payload: state });
  expect(witness.readCurrent).toHaveBeenCalledExactlyOnceWith(lineage, "3");
  expect(await admitManagedNumberingCheckpoint(exact, { ...witness, expectedGeneration: "4" }))
    .toEqual({ ok: false, reason: "freshness-mismatch" });
  const routedElsewhere = encodeManagedNumberingCheckpoint(state, Buffer.from("other exact attachment"));
  expect(await admitManagedNumberingCheckpoint(routedElsewhere, witness)).toEqual({ ok: false, reason: "freshness-mismatch" });
  const oldBody = encodeNumberingRecovery(state.numbering);
  // v1 remains available to its historical reader, not this managed verifier.
  expect(await admitNumberingRecovery(oldBody.bytes, oldBody.manifest, authority(oldBody.manifest))).toMatchObject({ ok: true });
  expect(await admitManagedNumberingCheckpoint(Buffer.from(oldBody.bytes), witness)).toEqual({ ok: false, reason: "invalid-payload" });
});
it.each([
  (x: ManagedNumberingPayload) => { x.dispositions.shift(); },
  (x: ManagedNumberingPayload) => { x.dispositions[0].actor = "98"; },
  (x: ManagedNumberingPayload) => { x.dispositions[0].state = "retired"; },
  (x: ManagedNumberingPayload) => { x.dispositions[1].state = "committed"; },
  (x: ManagedNumberingPayload) => { x.dispositions[1].request = x.dispositions[0].request; },
  (x: ManagedNumberingPayload) => { x.dispositions[1].expiresAtMs = "9007199254740993"; },
  (x: ManagedNumberingPayload) => { x.dispositions[1].lineage = other; },
  (x: ManagedNumberingPayload) => { x.managed.lineage = other; },
  (x: ManagedNumberingPayload) => { Object.assign(x.dispositions[1], { signedToken: "forbidden" }); },
  (x: ManagedNumberingPayload) => { x.numbering.audit.pop(); },
  (x: ManagedNumberingPayload) => { x.dispositions = new Array(100_001).fill(x.dispositions[0]); },
])("rejects incomplete, mismatched, duplicate, oversized or expanded v2 ledgers", mutate => {
  const state = v2(); mutate(state);
  expect(() => encodeManagedNumberingSidecar(state)).toThrow();
});
it("rejects ambiguous/malformed container bytes before querying custody", async () => {
  const state = v2(), exact = encodeManagedNumberingCheckpoint(state, attachment);
  const witness = currentV2(state, exact);
  const corruptHeader = Buffer.from(exact); corruptHeader[148] ^= 1;
  const extraEnd = Buffer.concat([exact, Buffer.alloc(512)]);
  const corruptedAttachment = Buffer.from(exact);
  const offset = corruptedAttachment.indexOf(attachment);
  expect(offset).toBeGreaterThan(0); corruptedAttachment[offset] ^= 1;
  for (const candidate of [corruptHeader, exact.subarray(0, -512), extraEnd, corruptedAttachment]) {
    expect(await admitManagedNumberingCheckpoint(candidate, witness)).toEqual({ ok: false, reason: "invalid-payload" });
  }
  expect(witness.readCurrent).not.toHaveBeenCalled();
});
