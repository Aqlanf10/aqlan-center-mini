import { describe, expect, it } from "vitest";
import { HISTORY_QUESTIONS, deriveAlerts, normalizeMedicalHistory, normalizeVitals, reviewDue } from "../lib/medical-history";

/** (PAT-2) التاريخ الطبي المنظَّم والعلامات الحيوية — منطقٌ خالص. */

describe("medical history questionnaire", () => {
  it("fills every question (unknown by default), trims lists, and refuses bad ASA/blood group in Arabic", () => {
    const parsed = normalizeMedicalHistory({
      answers: { diabetes: "yes", anticoagulants: "no", bogus: "yes" },
      allergies: [{ substance: " بنسلين ", reaction: "طفح", severity: "severe" }, { substance: "" }],
      medications: [{ name: "ميتفورمين", dose: "500mg" }, { name: "  " }],
      asaClass: "II", bloodGroup: "O+", notes: "  ", patientConfirmed: true,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.value.answers)).toHaveLength(HISTORY_QUESTIONS.length);
    expect(parsed.value.answers).toMatchObject({ diabetes: "yes", anticoagulants: "no", pregnancy: "unknown" });
    expect(parsed.value.answers).not.toHaveProperty("bogus");
    expect(parsed.value.allergies).toEqual([{ substance: "بنسلين", reaction: "طفح", severity: "severe" }]);
    expect(parsed.value.medications).toEqual([{ name: "ميتفورمين", dose: "500mg" }]);
    expect(parsed.value).toMatchObject({ asaClass: "II", bloodGroup: "O+", notes: null, patientConfirmed: true });
    expect(normalizeMedicalHistory({ asaClass: "VI" })).toMatchObject({ ok: false, message: expect.stringContaining("ASA") });
    expect(normalizeMedicalHistory({ bloodGroup: "C+" })).toMatchObject({ ok: false, message: expect.stringContaining("فصيلة") });
  });

  it("derives alerts: allergies (severe first), risky yes answers, and ASA III+", () => {
    const alerts = deriveAlerts({
      answers: { anticoagulants: "yes", diabetes: "yes", thyroid: "yes", pregnancy: "no" },
      allergies: [{ substance: "لاتكس", reaction: null, severity: "mild" }, { substance: "بنسلين", reaction: null, severity: "severe" }],
      asaClass: "III",
    });
    expect(alerts).toEqual([
      { label: "حساسية بنسلين (شديدة)", severity: "high" },
      { label: "حساسية لاتكس", severity: "medium" },
      { label: "سكري", severity: "medium" },
      { label: "على مميّعات دم", severity: "high" },
      { label: "ASA III", severity: "high" },
    ]);
  });

  it("asks for a review when there is no history or it is older than the setting", () => {
    expect(reviewDue(null, 6, "2026-09-26")).toEqual({ due: true, months: 6 });
    expect(reviewDue("2026-05-01T10:00:00.000Z", 6, "2026-09-26").due).toBe(false);
    expect(reviewDue("2026-03-01T10:00:00.000Z", 6, "2026-09-26").due).toBe(true);
  });
});

describe("vital signs", () => {
  it("accepts sensible readings and refuses impossible ones in Arabic", () => {
    expect(normalizeVitals({ bpSystolic: "130", bpDiastolic: 85, pulse: 72, temperature: "37.26", weightKg: "70.04" }))
      .toEqual({ ok: true, value: { bpSystolic: 130, bpDiastolic: 85, pulse: 72, temperature: 37.3, spo2: null, glucose: null, weightKg: 70 } });
    expect(normalizeVitals({ bpSystolic: 130 })).toMatchObject({ ok: false, message: expect.stringContaining("كاملًا") });
    expect(normalizeVitals({ bpSystolic: 80, bpDiastolic: 90 })).toMatchObject({ ok: false });
    expect(normalizeVitals({ pulse: 400 })).toMatchObject({ ok: false, message: expect.stringContaining("النبض") });
    expect(normalizeVitals({})).toMatchObject({ ok: false, message: expect.stringContaining("قراءةً") });
  });
});
