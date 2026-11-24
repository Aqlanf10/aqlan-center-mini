import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { ReceptionPatientEditor } from "../components/patient/ReceptionPatientEditor";
import {
  makeReceptionPatientForm, patientIdentityEditMode, readAdministrativePatientChange,
} from "../lib/patient-administrative-edit";

// Real form event handlers + reducer with a synthetic React hook lifecycle.
// The only transport is a mock: no server, database or real patient.
const hooks = vi.hoisted(() => ({ slot: 0, values: [] as unknown[], cleanup: undefined as undefined | (() => void) }));
vi.mock("@/components/SettingsProvider", () => ({ useSetting: () => "Synthetic source" }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.slot++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next;
    }];
  };
  return {
    ...react, useState: state,
    useRef: (initial: unknown) => state({ current: initial })[0],
    useLayoutEffect: (setup: () => () => void) => { hooks.cleanup ??= setup(); },
  };
});

type Element = ReactElement<Record<string, unknown>>;
function flatten(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const item = node as Element;
  return [item, ...flatten(item.props.children as ReactNode)];
}
function plainText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(plainText).join(" ");
  return node && typeof node === "object" && "props" in node ? plainText((node as Element).props.children as ReactNode) : "";
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

const baseline = {
  id: 121, patientNumber: "SYN-121", fullName: "Synthetic patient", phone: "00000111", altPhone: null,
  gender: "unknown" as const, birthYear: 1999, birthDate: "1999-01-01", address: null, email: null,
  medicalAlert: "SYN-ALERT", note: "SYN-NOTE", nationalId: "SYN-ID", photoDocumentId: 99,
  createdAt: "2026-01-01",
};
const fetchMock = vi.fn();
const onSaved = vi.fn();
const onCancel = vi.fn();
const render = () => {
  hooks.slot = 0;
  return ReceptionPatientEditor({ patientId: baseline.id, initial: makeReceptionPatientForm(baseline), onSaved, onCancel });
};
function field(label: string) {
  const control = flatten(render()).find((node) => node.type === "label" && plainText(node.props.children as ReactNode).trim() === label);
  const input = flatten(control?.props.children as ReactNode).find((node) => node.type === "input" || node.type === "select");
  expect(input).toBeDefined();
  return input!;
}
function change(label: string, value: string) {
  (field(label).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
function submit() {
  (render().props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
}
const json = (payload: unknown) => ({ ok: true, json: async () => payload });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  vi.resetAllMocks(); hooks.slot = 0; hooks.values = []; hooks.cleanup = undefined;
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { hooks.cleanup?.(); vi.unstubAllGlobals(); });

describe("role-aware patient identity editor", () => {
  it("keeps clinical edits with admins and edit-enabled doctors; no assistant edit mode", () => {
    expect(patientIdentityEditMode({ role: "reception" })).toBe("administrative");
    expect(patientIdentityEditMode({ role: "admin" })).toBe("clinical");
    expect(patientIdentityEditMode({ role: "doctor" })).toBe("clinical");
    expect(patientIdentityEditMode({ role: "doctor", permissions: { canEditPatient: false } })).toBeNull();
    for (const role of ["assistant", "cashier", "accountant", "unknown"]) expect(patientIdentityEditMode({ role })).toBeNull();
    expect(patientIdentityEditMode(null)).toBeNull();
  });

  it("renders only administrative fields and saves the changed phone, email and name exactly once", async () => {
    const initial = render();
    expect(plainText(initial)).not.toMatch(/تنبيه طبي|ملاحظات عامة|جواز|SYN-ALERT|SYN-NOTE|SYN-ID/);
    expect(makeReceptionPatientForm(baseline)).not.toHaveProperty("medicalAlert");
    expect(makeReceptionPatientForm(baseline)).not.toHaveProperty("nationalId");
    submit();
    expect(fetchMock).not.toHaveBeenCalled();
    change("الاسم الكامل", "Synthetic renamed patient");
    change("رقم الجوال", "00000222");
    change("البريد الإلكتروني", "TEST@EXAMPLE.INVALID");
    const pending = deferred<ReturnType<typeof json>>();
    fetchMock.mockReturnValue(pending.promise);
    submit(); submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/patients/121");
    expect(JSON.parse(options.body)).toEqual({ fullName: "Synthetic renamed patient", phone: "00000222", email: "TEST@EXAMPLE.INVALID" });
    const expected = { fullName: "Synthetic renamed patient", phone: "00000222", email: "test@example.invalid" };
    pending.resolve(json({ ...baseline, ...expected }));
    await settle();
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it("does not accept a mismatched acknowledgement and allows correction", async () => {
    change("رقم الجوال", "00000222");
    fetchMock.mockResolvedValueOnce(json({ id: 122, phone: "00000222" }));
    submit(); await settle();
    expect(onSaved).not.toHaveBeenCalled();
    expect(plainText(render())).toContain("لم يمكن تأكيد البيانات المحفوظة");
    fetchMock.mockResolvedValueOnce(json({ id: 121, phone: "00000222" }));
    submit(); await settle();
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({ phone: "00000222" });
  });

  it("retires an in-flight mutation when the already-authorized form is removed", async () => {
    change("رقم الجوال", "00000222");
    const pending = deferred<ReturnType<typeof json>>();
    fetchMock.mockReturnValue(pending.promise);
    submit();
    const signal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
    hooks.cleanup?.();
    expect(signal.aborted).toBe(true);
    pending.resolve(json({ id: 121, phone: "00000222" }));
    await settle();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("does not send a derived blank date and accepts the newer matching date the server preserved", async () => {
    change("سنة الميلاد", "2000");
    expect(field("تاريخ الميلاد (اختياري)").props.value).toBe("");
    const pending = deferred<ReturnType<typeof json>>();
    fetchMock.mockReturnValueOnce(pending.promise);
    submit();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ birthYear: "2000" });
    // A clinician's intervening change already supplied a date matching the
    // requested year. The actual database path may preserve and confirm it.
    pending.resolve(json({ id: 121, birthYear: 2000, birthDate: "2000-03-12" }));
    await settle();
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({ birthYear: 2000, birthDate: "2000-03-12" });
  });

  it("restores the date when the year returns to its original value and never submits a date clear", async () => {
    change("سنة الميلاد", "2000");
    expect(field("تاريخ الميلاد (اختياري)").props.value).toBe("");
    change("سنة الميلاد", "١٩٩٩");
    expect(field("تاريخ الميلاد (اختياري)").props.value).toBe("1999-01-01");
    submit();
    expect(fetchMock).not.toHaveBeenCalled();
    change("العنوان / الحي", "New synthetic address");
    fetchMock.mockResolvedValueOnce(json({ id: 121, address: "New synthetic address" }));
    submit(); await settle();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ address: "New synthetic address" });
  });

  it("submits an explicit replacement date and lets the server derive its year", async () => {
    change("تاريخ الميلاد (اختياري)", "2000-05-17");
    expect(field("سنة الميلاد").props.value).toBe("2000");
    fetchMock.mockResolvedValueOnce(json({ id: 121, birthDate: "2000-05-17", birthYear: 2000 }));
    submit(); await settle();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ birthDate: "2000-05-17" });
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({ birthDate: "2000-05-17", birthYear: 2000 });
  });

  it("preserves explicit clearing without submitting a year derived from an abandoned date", async () => {
    change("تاريخ الميلاد (اختياري)", "2000-05-17");
    change("تاريخ الميلاد (اختياري)", "");
    expect(field("سنة الميلاد").props.value).toBe("1999");
    fetchMock.mockResolvedValueOnce(json({ id: 121, birthDate: null, birthYear: 1999 }));
    submit(); await settle();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ birthDate: "" });
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({ birthDate: null, birthYear: 1999 });
  });

  it("restores the earlier manual year when a subsequently entered full date is cleared", async () => {
    change("سنة الميلاد", "2001");
    change("تاريخ الميلاد (اختياري)", "2000-05-17");
    expect(field("سنة الميلاد").props.value).toBe("2000");
    change("تاريخ الميلاد (اختياري)", "");
    expect(field("سنة الميلاد").props.value).toBe("2001");
    fetchMock.mockResolvedValueOnce(json({ id: 121, birthDate: null, birthYear: 2001 }));
    submit(); await settle();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ birthYear: "2001", birthDate: "" });
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({ birthDate: null, birthYear: 2001 });
  });

  it("uses an allowlisted changed-field acknowledgement for existing flags/channel saves and paired date fields", () => {
    const row = { ...baseline, flags: ["Synthetic flag"], preferredChannel: "email" };
    expect(readAdministrativePatientChange(row, baseline.id, { flags: ["Synthetic flag"] })).toEqual({ flags: ["Synthetic flag"] });
    expect(readAdministrativePatientChange(row, baseline.id, { preferredChannel: "email" })).toEqual({ preferredChannel: "email" });
    expect(readAdministrativePatientChange(row, baseline.id, { birthDate: "1999-01-01" })).toEqual({ birthDate: "1999-01-01", birthYear: 1999 });
    expect(readAdministrativePatientChange({ id: baseline.id }, baseline.id, { phone: "00000111" })).toBeNull();
  });
});
