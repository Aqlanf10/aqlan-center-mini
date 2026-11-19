import { readFileSync } from "node:fs";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PHOTO_CHECKLIST_LIMITS, parsePhotoChecklist } from "@/lib/ortho-photos";
import { PUBLIC_SETTING_KEYS, SETTING_DEFAULTS } from "@/lib/settings";
import { validateTypedSetting } from "@/lib/settings-validate";
import { SETTING_KEY_CLASSES } from "@/lib/settings-capabilities";
import { PhotoChecklistCard } from "../components/OrthoPhotoChecklist";
import { AdjustmentForm } from "../components/PatientOrtho";
import { SettingsProvider } from "../components/SettingsProvider";

/** OP-4 (contract v2.1). The checklist text is clinic-authored; empty by default = hidden. Synthetic text only. */
const SYN = "SYN بند أول، مع فاصلة داخل البند\nSYN بند ثانٍ\n\n  SYN بند أول، مع فاصلة داخل البند  \nSYN بند ثالث";

describe("photo checklist setting (OP-4)", () => {
  it("is empty by default, public (no patient data), operational, and parsed one item per line", () => {
    expect(SETTING_DEFAULTS["ortho.photo_checklist"]).toBe("");
    expect(PUBLIC_SETTING_KEYS).toContain("ortho.photo_checklist");
    expect(SETTING_KEY_CLASSES["ortho.photo_checklist"].class).toBe("operational");
    expect(parsePhotoChecklist("")).toEqual([]);
    expect(parsePhotoChecklist(undefined)).toEqual([]);
    expect(parsePhotoChecklist(SYN)).toEqual(["SYN بند أول، مع فاصلة داخل البند", "SYN بند ثانٍ", "SYN بند ثالث"]);
  });

  it("validates on save with Arabic messages; empty is valid", () => {
    expect(validateTypedSetting("ortho.photo_checklist", "")).toBeNull();
    expect(validateTypedSetting("ortho.photo_checklist", SYN)).toBeNull();
    const tooMany = Array.from({ length: PHOTO_CHECKLIST_LIMITS.items + 1 }, (_, i) => `SYN ${i}`).join("\n");
    expect(validateTypedSetting("ortho.photo_checklist", tooMany)).toMatch(/[؀-ۿ]/);
    expect(validateTypedSetting("ortho.photo_checklist", "x".repeat(PHOTO_CHECKLIST_LIMITS.chars + 1))).toMatch(/[؀-ۿ]/);
  });
});

describe("PhotoChecklistCard (OP-4)", () => {
  it("renders nothing when the clinic has not written a checklist", () => {
    expect(renderToStaticMarkup(createElement(PhotoChecklistCard, { items: [] }))).toBe("");
  });

  it("is a collapsed, read-only reminder: no inputs, no stored answers", () => {
    const out = renderToStaticMarkup(createElement(PhotoChecklistCard, { items: parsePhotoChecklist(SYN) }));
    expect(out).toMatch(/^<details/);
    expect(out).not.toContain("<details open");
    expect(out).toContain("تذكير ثبات التصوير (3)");
    for (const item of parsePhotoChecklist(SYN)) expect(out).toContain(item);
    expect(out).not.toMatch(/<input|<button|<select|<textarea|required/);
  });
});

describe("session form integration (no new step)", () => {
  type Case = ComponentProps<typeof AdjustmentForm>["caseRow"];
  const caseRow = {
    id: 9, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null, status: "active", phase: "aligning",
    startDate: "2026-01-01", plannedMonths: 18, upperWire: "016 NiTi", lowerWire: "014 NiTi", planId: null, retainer: null,
    retainerOn: null, note: null, closedAt: null, closedBy: null, closedNote: null, baselineKind: null, baselineRecordedAt: null,
    elastics: null, responsibleDoctorName: null, legacyFinancialMode: null, remainingObjectives: null, photosVisible: true,
    adjustments: [], progress: { monthsElapsed: 0, monthsPlanned: 18, monthsRemaining: 18, percent: 0, overdue: false, adjustments: 0, lastAdjustment: null, daysSinceLast: null },
  } as unknown as Case;
  const form = (checklist: string, row: Case = caseRow) => renderToStaticMarkup(createElement(SettingsProvider, {
    value: { "ortho.photo_checklist": checklist },
    children: createElement(AdjustmentForm, { caseRow: row, today: "2026-01-05", wires: [], patientId: 1, onSaved: () => {}, onError: () => {} }),
  }));

  it("an empty checklist leaves the session form exactly as before", () => {
    expect(form("")).toBe(renderToStaticMarkup(createElement(AdjustmentForm, { caseRow, today: "2026-01-05", wires: [], patientId: 1, onSaved: () => {}, onError: () => {} })));
  });

  it("with clinic text but no confirmed full-set notice, the form is unchanged (no reminder, no input)", () => {
    // Static render cannot confirm saved photo history, so no full-set notice is required here.
    const withText = form(SYN);
    expect(withText).not.toContain("أول توثيقٍ للعلاج");
    expect(withText).toBe(form(""));
  });

  it("the reminder is wired only inside the existing required full-set notice, with no form field", () => {
    const source = readFileSync(new URL("../components/PatientOrtho.tsx", import.meta.url), "utf8");
    expect(source).toContain("{fullSet?.required ? <PhotoChecklistCard items={photoChecklist} /> : null}");
    expect(source.match(/<PhotoChecklistCard\b/g)).toHaveLength(1);
    expect(source).not.toMatch(/photoChecklist[^\n]*(form\.field|uploadForm|body\.|JSON\.stringify)/);
  });
});
