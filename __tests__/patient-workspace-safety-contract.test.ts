import { describe, expect, it } from "vitest";
import { deriveReadiness, patientContextAlerts, type ReadinessFacts } from "../lib/chair-readiness";

const historyAlerts = ["حساسية لاتكس (شديدة)", "على مميّعات دم"];
const facts: ReadinessFacts = {
  patientId: 91,
  medicalAlert: "  تنبيه الملف القابل للتعديل  ",
  flags: [],
  intakeAt: null,
  history: {
    recordedAt: "2026-10-03T00:00:00Z",
    answers: { anticoagulants: "yes" },
    allergies: [{ substance: "لاتكس", reaction: null, severity: "severe" }],
    asaClass: null,
  },
};

describe("patient workspace canonical safety sources", () => {
  it("keeps the legacy combined list and derives the history subset from the same medical facts", () => {
    const result = deriveReadiness(facts, 6, "2026-10-03");
    expect(result.alerts).toEqual(["تنبيه الملف القابل للتعديل", ...historyAlerts]);
    expect(result.historyAlerts).toEqual(historyAlerts);
    expect(result.items.find((item) => item.key === "alerts")).toEqual({
      key: "alerts", state: "attention", label: `تنبيه طبي: ${result.alerts.join(" • ")}`,
    });
    expect(result.attention).toBe(1);
  });

  it("returns no medical warnings for a walk-in without a patient file", () => {
    expect(deriveReadiness({ ...facts, patientId: null }, 6, "2026-10-03")).toEqual({
      items: [{ key: "file", state: "attention", label: "بلا ملف — اربطه بملفٍّ أو افتحه" }],
      attention: 1, alerts: [], historyAlerts: [],
    });
  });

  it("does not invent history warnings when no medical history exists", () => {
    expect(deriveReadiness({ ...facts, history: null }, 6, "2026-10-03"))
      .toMatchObject({ alerts: ["تنبيه الملف القابل للتعديل"], historyAlerts: [] });
  });
});

describe("patient workspace confirmed-save and fallback safety contract", () => {
  const snapshot = { alerts: ["تنبيه قديم", ...historyAlerts], historyAlerts };

  it("uses the current patient alert before any visit or readiness response exists", () => {
    expect(patientContextAlerts("  تنبيه حالي  ", null)).toEqual(["تنبيه حالي"]);
    expect(patientContextAlerts(null, null)).toEqual([]);
  });

  it("replaces the editable warning independently of persisted history warnings", () => {
    expect(patientContextAlerts("تنبيه جديد", snapshot)).toEqual(["تنبيه جديد", ...historyAlerts]);
    expect(patientContextAlerts(null, snapshot)).toEqual(historyAlerts);
    expect(patientContextAlerts("  ", snapshot)).toEqual(historyAlerts);
  });

  it("deduplicates exact labels without guessing that similar medical warnings are equivalent", () => {
    expect(patientContextAlerts(historyAlerts[0], snapshot)).toEqual(historyAlerts);
    expect(patientContextAlerts("حساسية لاتكس", snapshot)).toEqual(["حساسية لاتكس", ...historyAlerts]);
  });

  it("conservatively preserves warnings from an old server with no explicit history subset", () => {
    const older = { alerts: ["تنبيه قديم", "تنبيه قديم", ...historyAlerts] };
    expect(patientContextAlerts("تنبيه جديد", older)).toEqual(["تنبيه جديد", "تنبيه قديم", ...historyAlerts]);
    expect(patientContextAlerts(null, older)).toEqual(["تنبيه قديم", ...historyAlerts]);
  });

  it("treats an explicit null or empty history subset as authoritative instead of using combined alerts", () => {
    expect(patientContextAlerts("تنبيه حالي", { alerts: ["يجب ألا يظهر"], historyAlerts: null }))
      .toEqual(["تنبيه حالي"]);
    expect(patientContextAlerts(null, { alerts: ["يجب ألا يظهر"], historyAlerts: [] })).toEqual([]);
  });

  it("uses an explicit server editable source only when the client stamped the request revision", () => {
    const response = { ...snapshot, editableAlert: "تنبيه من موظف آخر" };
    expect(patientContextAlerts("تنبيه الملف", response)).toEqual(["تنبيه الملف", ...historyAlerts]);
    expect(patientContextAlerts("تنبيه الملف", { ...response, confirmedAlertRevision: 0 }))
      .toEqual(["تنبيه من موظف آخر", ...historyAlerts]);
  });

  it("prevents a response started before a confirmed save from restoring the old editable warning", () => {
    const beforeSave = { ...snapshot, editableAlert: "تنبيه قديم", confirmedAlertRevision: 0 };
    const saved = { revision: 1, value: "تنبيه محفوظ الآن" };
    expect(patientContextAlerts("نص ملف قديم", beforeSave, saved)).toEqual([saved.value, ...historyAlerts]);
    expect(patientContextAlerts("نص ملف قديم", beforeSave, { revision: 1, value: null })).toEqual(historyAlerts);
  });

  it("retains a later local save against requests started between two confirmed saves", () => {
    const betweenSaves = { ...snapshot, editableAlert: "الحفظ الأول", confirmedAlertRevision: 1 };
    expect(patientContextAlerts("الحفظ الأول", betweenSaves, { revision: 2, value: "الحفظ الثاني" }))
      .toEqual(["الحفظ الثاني", ...historyAlerts]);
  });

  it("allows later remote edits and deletions after a request starts at the current save revision", () => {
    const saved = { revision: 2, value: "تنبيه محلي محفوظ" };
    const current = { ...snapshot, editableAlert: "تعديل موظف آخر", confirmedAlertRevision: 2 };
    expect(patientContextAlerts(saved.value, current, saved)).toEqual(["تعديل موظف آخر", ...historyAlerts]);
    expect(patientContextAlerts(saved.value, { ...current, editableAlert: null }, saved)).toEqual(historyAlerts);
  });

  it("does not recover hidden text from a current redacted response", () => {
    const hidden = { alerts: null, historyAlerts: null, editableAlert: null, confirmedAlertRevision: 1 };
    expect(patientContextAlerts("نص ملف قديم", hidden, { revision: 1, value: "نص محفوظ" })).toEqual([]);
  });
});
