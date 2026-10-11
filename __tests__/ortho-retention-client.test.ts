import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { RETENTION_RESPONSE_BYTE_LIMIT, readRetentionRead, readRetentionResponseJSON, retentionTreatmentStatus, verifyRetentionRead, verifyRetentionSaved } from "../lib/ortho-retention-client";
import { delivery, expectation, hash, occurrence, readFixture, row, savedFixture, scope } from "./fixtures/ortho-retention-ui";
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());
describe("retention browser response boundary", () => {
  it("reads an empty assessment case without inferring treatment eligibility", async () => {
    const raw = { ...readFixture(), status: "assessment", canAppend: true };
    const read = await verifyRetentionRead(raw, scope);
    expect(read.revision).toBeNull(); expect(read.devices).toEqual([]); expect(retentionTreatmentStatus(read.status)).toBe(false);
    expect(retentionTreatmentStatus("assessment_cancelled")).toBe(false);
    for (const status of ["active", "retention", "completed", "discontinued"]) expect(retentionTreatmentStatus(status)).toBe(true);
  });
  it("preserves two physical devices on one arch and unknown clinical dates", async () => {
    const raw = readFixture([row(300, 1, delivery("fixed")), row(12, 2, { ...delivery("removable"), deviceType: "removable" } as ReturnType<typeof delivery>)]);
    const read = await verifyRetentionRead(raw, scope);
    expect(read.devices.map(d => d.deviceId)).toEqual([300, 12]);
    expect(read.devices.every(d => d.intervalStart === null && d.currentState === "ambiguous")).toBe(true);
    expect(read.currentEvents.every(e => e.content.occurrence.occurredOn === null)).toBe(true);
    raw.devices[0].delivery.description = "mutated after read"; expect(read.devices[0].delivery.description).toBe("fixed");
  });
  it("keeps replacement as a new physical root and supports an explicitly selected historical revision", async () => {
    const raw = readFixture([row(101, 1, delivery()), row(102, 2, { ...delivery("replacement"), kind: "device_replacement", replaces: { deviceId: 101, expectedDeviceRevisionId: 101 } } as Parameters<typeof row>[2])], 101);
    const read = await verifyRetentionRead(raw, scope, 101);
    expect(read.revision?.id).toBe(101); expect(read.devices.map(d => [d.deviceId, d.replacedDeviceId])).toEqual([[101, null], [102, 101]]);
    expect(() => readRetentionRead(raw, scope)).toThrow("retention_selected_revision_mismatch");
  });
  it("keeps a corrected delivery under its original root without reconstructing missing superseded content", async () => {
    const raw = readFixture([row(101, 1, delivery()), row(103, 2, delivery("corrected"), { supersedesEntryId: 101 })]);
    const read = await verifyRetentionRead(raw, scope);
    expect(read.devices[0].deviceId).toBe(101); expect(read.devices[0].deliveryRevisionId).toBe(103); expect(read.currentEvents.map(e => e.id)).toEqual([103]);
  });
  it("rejects wrong scope, missing or malformed identity, broken history and fabricated projections", () => {
    const base = readFixture([row(101, 1, delivery()), row(102, 2, { kind: "device_repair", occurrence, documentIds: [], note: "", description: "repair", device: { deviceId: 101, expectedDeviceRevisionId: 101 } })]);
    const mutations = [
      (r: typeof base) => { r.patientId++; }, (r: typeof base) => { r.history[0].predecessorId = null; },
      (r: typeof base) => { r.history[1].version = 2; }, (r: typeof base) => { r.devices[0].lastEventId = 999; },
      (r: typeof base) => { r.currentEvents[0].id = 999; }, (r: typeof base) => { r.devices[0].arch = "lower"; },
      (r: typeof base) => { r.devices[0].delivery.description = "different"; }, (r: typeof base) => { r.currentEvents.pop(); },
      (r: typeof base) => { r.devices = []; }, (r: typeof base) => { r.revision!.createdAt = "2026-02-30T00:00:00.000Z"; },
    ];
    // The HTTP JSON envelope has independent objects, unlike structuredClone,
    // which preserves this fixture's shared delivery/event object references.
    for (const [index, mutate] of mutations.entries()) {
      const raw: typeof base = JSON.parse(JSON.stringify(base)); mutate(raw);
      expect(() => readRetentionRead(raw, scope), `invalid response mutation ${index}`).toThrow();
    }
    expect(() => readRetentionRead({ ...base, actorId: 7 }, scope)).toThrow();
  });
  it("rejects swapped physical roots and a head belonging to another device even when content hashes remain valid", async () => {
    const original = readFixture([row(101, 1, delivery("fixed")), row(102, 2, delivery("removable"))]);
    const swapped = structuredClone(original);
    swapped.devices[0].deviceId = 102; swapped.devices[0].lastEventId = 102;
    swapped.devices[1].deviceId = 101; swapped.devices[1].lastEventId = 102;
    await expect(verifyRetentionRead(swapped, scope)).rejects.toThrow("retention_device_identity_mismatch");
    const wrongHead = structuredClone(original); wrongHead.devices[0].lastEventId = 102;
    await expect(verifyRetentionRead(wrongHead, scope)).rejects.toThrow("retention_device_identity_mismatch");
    const corrected = readFixture([row(101, 1, delivery()), row(102, 2, delivery("correction"), { supersedesEntryId: 101 })]);
    corrected.devices[0].deviceId = 102;
    await expect(verifyRetentionRead(corrected, scope)).rejects.toThrow("retention_device_identity_mismatch");
  });
  it("rejects an event retained alongside its direct correction", async () => {
    const original = row(101, 1, delivery());
    const raw = readFixture([original, row(102, 2, delivery("corrected"), { supersedesEntryId: 101 })]);
    raw.currentEvents.unshift(original);
    await expect(verifyRetentionRead(raw, scope)).rejects.toThrow("retention_event_identity_mismatch");
  });
  it("verifies both selected and current-event stored content hashes", async () => {
    const selected = readFixture([row(101, 1, delivery())]); selected.revision!.content.payload.note = "different";
    await expect(verifyRetentionRead(selected, scope)).rejects.toThrow("retention_revision_hash_mismatch");
    const current = readFixture([row(101, 1, delivery()), row(102, 2, { kind: "debond", occurrence, documentIds: [], note: "", extent: "upper" })]);
    current.currentEvents[0].content.note = "different"; current.devices[0].delivery.note = "different";
    await expect(verifyRetentionRead(current, scope)).rejects.toThrow("retention_event_hash_mismatch");
  });
  it("binds success and historical replay to actual actor, command, revision, content and predecessor", async () => {
    const expected = expectation(); const saved = savedFixture(expected);
    expect((await verifyRetentionSaved(saved, expected, 201)).revision.id).toBe(111);
    expect((await verifyRetentionSaved(savedFixture(expected, true), expected, 200)).replayed).toBe(true);
    for (const mutate of [
      (r: typeof saved) => { r.acknowledgment.actorId++; }, (r: typeof saved) => { r.acknowledgment.commandId = "foreign_command_001"; },
      (r: typeof saved) => { r.acknowledgment.revisionId++; }, (r: typeof saved) => { r.acknowledgment.requestFingerprint = "0".repeat(64); },
      (r: typeof saved) => { r.revision.version++; }, (r: typeof saved) => { r.revision.predecessorId = 222; },
      (r: typeof saved) => { r.revision.reason = "changed"; }, (r: typeof saved) => { r.revision.content.payload.note = "changed"; r.revision.contentHash = hash(r.revision.content); },
    ]) { const changed = structuredClone(saved); mutate(changed); await expect(verifyRetentionSaved(changed, expected, 201)).rejects.toThrow(); }
    await expect(verifyRetentionSaved(saved, expected, 200)).rejects.toThrow("invalid_retention_saved_status");
  });
  it("detaches expected and response values before the asynchronous digest", async () => {
    const expected = expectation(), raw = savedFixture(expected);
    const pending = verifyRetentionSaved(raw, expected, 201);
    expected.command.reason = "mutated"; expected.command.content.note = "mutated"; expected.actorId = 99;
    raw.replayed = true; raw.revision.reason = "mutated";
    const result = await pending; expect(result.replayed).toBe(false); expect(result.revision.reason).toBe("Synthetic documentary event");
  });
  it("bounds network bytes and detached JSON before projection or hashing", async () => {
    expect(await readRetentionResponseJSON(new Response(JSON.stringify(readFixture())))).toMatchObject({ ok: true });
    await expect(readRetentionResponseJSON(new Response("{}", { headers: { "content-length": String(RETENTION_RESPONSE_BYTE_LIMIT + 1) } }))).rejects.toThrow("retention_response_limit");
    await expect(readRetentionResponseJSON(new Response(new Uint8Array([0xff])))).rejects.toThrow();
    let calls = 0; const stream = new ReadableStream<Uint8Array>({ pull(controller) { calls++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() {} });
    await expect(readRetentionResponseJSON(new Response(stream))).rejects.toThrow("retention_response_limit"); expect(calls).toBeLessThan(28);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => readRetentionRead(cyclic, scope)).toThrow();
    const accessor = { ...readFixture() }; Object.defineProperty(accessor, "devices", { enumerable: true, get() { throw new Error("getter must not run"); } });
    expect(() => readRetentionRead(accessor, scope)).toThrow("invalid_retention_response");
    expect(() => readRetentionRead({ ...readFixture(), history: new Array(5001).fill(null) }, scope)).toThrow("retention_response_limit");
  });
});
