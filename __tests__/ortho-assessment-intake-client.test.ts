import { describe, expect, it, vi } from "vitest";
import { confirmIntakeResponse, isVerifiedIntakeRead, prepareIntakeSave, readIntakeJson, readIntakeRefusal, readIntakeResponse,
  serializeIntakeCommand, type IntakeBridgeWitness, type IntakePlanWitness } from "../lib/ortho-assessment-intake-client";
import { activateCommand, assessmentRead, cancelCommand, emptyRead, eventFor, hash, openCommand, saved } from "./ortho-assessment-intake-fixtures";
const scope = { patientId: 7, orthoCaseId: 8, clinicalCaseId: 9 };
describe("bounded browser 0054 intake DTO", () => {
  it("admits an actual empty read, freezes detached choices and refuses arbitrary envelopes", async () => {
    const raw = emptyRead(), read = await readIntakeResponse(raw, { patientId: 7 });
    expect(read).not.toBeNull(); expect(isVerifiedIntakeRead(read!)).toBe(true); expect(isVerifiedIntakeRead(raw)).toBe(false);
    expect(Object.isFrozen(read)).toBe(true); expect(Object.isFrozen(read!.plans)).toBe(true);
    for (const invalid of [{ ...raw, patientId: 6 }, { ...raw, extra: true }, { ...raw, writable: "true" },
      { ...raw, history: Array(3).fill(null) }, { ...raw, plans: Array(101).fill(null) }, { ...raw, clinicalCases: Array(101).fill(null) },
      { ...raw, openCase: { orthoCaseId: 8, clinicalCaseId: 9, status: "future", lifecycleVersion: 0 } }])
      expect(await readIntakeResponse(invalid, { patientId: 7 })).toBeNull();
    expect(await readIntakeResponse(raw, scope)).toBeNull();
  });
  it("requires normalized exact choice IDs/hashes and shows missing consent without imposing a consent prerequisite", async () => {
    const witness: IntakeBridgeWitness = { version: "ortho-intake-bridge-1", id: 9, patientId: 7,
      specialty: "orthodontics", status: "waiting", site: null, orthoCaseId: null };
    const selected = { id: 9, contentHash: await hash(witness), title: "Synthetic old clinical episode", status: "waiting" as const, site: null, consent: "not_applicable" as const };
    const read = await readIntakeResponse({ ...emptyRead(), clinicalCases: [selected] }, { patientId: 7 });
    expect(read).not.toBeNull();
    expect(prepareIntakeSave({ command: openCommand(), read: read! }).ok).toBe(false);
    const command = { ...openCommand(), bridge: { mode: "existing" as const, clinicalCaseId: 9, expectedContentHash: selected.contentHash } };
    expect(prepareIntakeSave({ command, read: read! }).ok).toBe(true);
    expect(prepareIntakeSave({ command: { ...command, bridge: { ...command.bridge, expectedContentHash: "f".repeat(64) } }, read: read! }).ok).toBe(false);
    const duplicate = { ...emptyRead(), clinicalCases: [selected, selected] };
    expect(await readIntakeResponse(duplicate, { patientId: 7 })).toBeNull();
    const plan: IntakePlanWitness = { version: "ortho-intake-plan-1", id: 10, patientId: 7, status: "active", consentAt: null };
    const chosenPlan = { id: 10, contentHash: await hash(plan), title: "Synthetic plan", status: "active" as const, consent: "not_recorded" as const };
    const activationRead = await readIntakeResponse({ ...assessmentRead(await eventFor()), plans: [chosenPlan] }, scope);
    const activation = { ...activateCommand(), financialPlan: { id: 10, expectedContentHash: chosenPlan.contentHash } };
    const prepared = prepareIntakeSave({ command: activation, read: activationRead! });
    expect(prepared.ok).toBe(true);
    const response = saved(await eventFor(activation, { plan, consentPolicy: "existing_procedure_and_signature_guards_unchanged", consent: "not_recorded" }));
    if (prepared.ok) expect(await confirmIntakeResponse(response, prepared.value.expected, prepared.value.body)).not.toBeNull();
    expect(prepareIntakeSave({ command: { ...activation, financialPlan: { ...activation.financialPlan, expectedContentHash: "b".repeat(64) } }, read: activationRead! }).ok).toBe(false);
  });
  it("keeps explicit unknown treatment facts and refuses injected actor/time/finance fields", () => {
    const serialized = serializeIntakeCommand(activateCommand()); expect(serialized.ok).toBe(true);
    if (serialized.ok && serialized.value.command.kind === "activate_assessment") {
      expect(serialized.value.command.treatment).toMatchObject({ slot: null, plannedMonths: null, start: { state: "unknown" } });
      expect(Object.isFrozen(serialized.value.command.treatment.start)).toBe(true);
    }
    for (const extra of [{ actorId: 2 }, { recordedAt: "2026-10-11" }, { agreementId: 5 }, { consented: true }, { resume: true }])
      expect(serializeIntakeCommand({ ...openCommand(), ...extra }).ok).toBe(false);
    expect(serializeIntakeCommand({ ...activateCommand(), treatment: { ...activateCommand().treatment, slot: "unknown" } }).ok).toBe(false);
  });
  it("validates content SHA, recorded/current identity, version/predecessor and exact kind", async () => {
    const first = await eventFor(); const raw = assessmentRead(first);
    expect(await readIntakeResponse(raw, scope)).not.toBeNull();
    for (const changes of [{ contentHash: "0".repeat(64) }, { recordedPatientId: 2 }, { clinicalCaseId: 55 }, { orthoCaseId: 66 },
      { kind: "assessment_activated" }, { version: 2 }, { predecessorId: 39 }, { reason: "different reason" }, { actorUserId: 17 }])
      expect(await readIntakeResponse({ ...raw, history: [{ ...first, ...changes }] }, scope)).toBeNull();
    const activation = await eventFor(activateCommand());
    const active = { ...raw, openCase: { ...raw.openCase!, status: "active", lifecycleVersion: 2 }, history: [first, activation] };
    expect(await readIntakeResponse(active, scope)).not.toBeNull();
    expect(await readIntakeResponse({ ...active, history: [first, { ...activation, predecessorId: 999 }] }, scope)).toBeNull();
    expect(await readIntakeResponse({ ...active, history: [activation, first] }, scope)).toBeNull();
    // Existing pre-0054 treatment rows have version 0 and no invented opening.
    expect(await readIntakeResponse({ ...emptyRead(), openCase: { ...active.openCase, lifecycleVersion: 0 } }, scope)).not.toBeNull();
  });
  it("preserves immutable pre-merge command identity while verifying current ownership", async () => {
    const first = await eventFor(); const moved = { ...first, patientId: 70 };
    const read = await readIntakeResponse({ ...assessmentRead(moved), patientId: 70 }, { ...scope, patientId: 70 });
    expect(read?.history[0].recordedPatientId).toBe(7);
    const command = serializeIntakeCommand(openCommand()); if (!command.ok) throw new Error("fixture");
    const expected = { patientId: 70, command: command.value.command, predecessor: null };
    expect(await confirmIntakeResponse(saved(moved, true), expected, command.value.body)).not.toBeNull();
    expect(await confirmIntakeResponse(saved(moved, false), expected, command.value.body)).toBeNull();
    expect(await confirmIntakeResponse(saved({ ...moved, recordedPatientId: 70 }, true), expected, command.value.body)).toBeNull();
  });
  it("confirms the exact normalized command bytes, never a GET or a different command", async () => {
    const read = await readIntakeResponse(emptyRead(), { patientId: 7 });
    const prepared = prepareIntakeSave({ command: openCommand(), read: read! }); if (!prepared.ok) throw new Error("fixture");
    const response = saved(await eventFor());
    expect(await confirmIntakeResponse(response, prepared.value.expected, prepared.value.body)).not.toBeNull();
    expect(await confirmIntakeResponse(assessmentRead(response.event), prepared.value.expected, prepared.value.body)).toBeNull();
    expect(await confirmIntakeResponse(response, prepared.value.expected, prepared.value.body + " ")).toBeNull();
    const other = await eventFor({ ...openCommand(), commandId: "synthetic_other_command" });
    expect(await confirmIntakeResponse(saved(other), prepared.value.expected, prepared.value.body)).toBeNull();
    expect(await confirmIntakeResponse({ ...response, consentAtRecording: "recorded" }, prepared.value.expected, prepared.value.body)).toBeNull();
    expect(await confirmIntakeResponse({ ...response, replayed: "false" }, prepared.value.expected, prepared.value.body)).toBeNull();
    // recordedBy is display text only. No test claims it proves the stable actor ID.
    expect(response.event).not.toHaveProperty("actorUserId");
  });
  it("refuses reused-bridge cancellation and unsupported resume; admits newly-created shell cancellation", async () => {
    const read = await readIntakeResponse(assessmentRead(await eventFor()), scope);
    const prepared = prepareIntakeSave({ command: cancelCommand(), read: read! }); expect(prepared.ok).toBe(true);
    const cancellation = await eventFor(cancelCommand());
    if (prepared.ok) expect(await confirmIntakeResponse(saved(cancellation), prepared.value.expected, prepared.value.body)).not.toBeNull();
    const witness: IntakeBridgeWitness = { version: "ortho-intake-bridge-1", id: 9, patientId: 7,
      specialty: "orthodontics", status: "active", site: null, orthoCaseId: null };
    const command = { ...openCommand(), bridge: { mode: "existing" as const, clinicalCaseId: 9, expectedContentHash: await hash(witness) } };
    const opening = await eventFor(command, { bridgeAtOpening: witness, openingDateMeaning: "clinical_episode_opening_not_treatment_start" });
    const reused = await readIntakeResponse(assessmentRead(opening), scope); expect(reused).not.toBeNull();
    expect(prepareIntakeSave({ command: cancelCommand(), read: reused! }).ok).toBe(false);
    expect(await readIntakeResponse({ ...assessmentRead(opening), openCase: { orthoCaseId: 8, clinicalCaseId: 9, status: "assessment_cancelled", lifecycleVersion: 2 }, history: [opening, cancellation] }, scope)).toBeNull();
    expect(serializeIntakeCommand({ ...cancelCommand(), kind: "resume_assessment" }).ok).toBe(false);
  });
  it("fails closed on bounded parsing and unavailable digest", async () => {
    await expect(readIntakeJson(new Response("{}", { headers: { "content-length": "262145" } }))).rejects.toThrow("too_large");
    await expect(readIntakeJson(new Response("x".repeat(262145)))).rejects.toThrow("too_large");
    await expect(readIntakeJson(new Response("not JSON"))).rejects.toThrow();
    const raw = assessmentRead(await eventFor());
    const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("unavailable"));
    expect(await readIntakeResponse(raw, scope)).toBeNull(); digest.mockRestore();
  });
  it("admits only exact known refusal codes and matching status", () => {
    expect(readIntakeRefusal({ code: "lifecycle_changed", message: "Synthetic refused" }, 409)).not.toBeNull();
    for (const status of [200, 201, 401, 403, 500, 503]) expect(readIntakeRefusal({ code: "lifecycle_changed", message: "Synthetic refused" }, status)).toBeNull();
    for (const raw of [{ code: "unknown", message: "Synthetic" }, { code: "lifecycle_changed" }, { code: "lifecycle_changed", message: "Synthetic", ok: false },
      { code: "toString", message: "Synthetic" }]) expect(readIntakeRefusal(raw, 409)).toBeNull();
  });
});
