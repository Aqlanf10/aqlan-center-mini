import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PatientCockpit } from "../components/patient/PatientCockpit";
import { formatMoney } from "../lib/money";

const state = vi.hoisted(() => ({ cursor: 0, visit: null as Record<string, unknown> | null }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    const value = state.cursor++ === 0 ? state.visit : typeof initial === "function" ? initial() : initial;
    return [value, () => {}];
  } };
});
vi.mock("../components/SettingsProvider", () => ({ useChairCount: () => 4 }));

const props = {
  patientId: 91, patientName: "مريض اختبار واجهة طويلة الأسماء", patientPhone: null,
  fallbackAlert: null, summary: null, onOpenTab: () => {}, onChanged: () => {},
};
beforeEach(() => {
  state.cursor = 0;
  state.visit = {
    visitId: 21, status: "in_chair", chair: 1, signedAt: null, seatedAt: "2026-10-03T00:00:00Z",
    arrivedAt: "2026-10-03T00:00:00Z", alerts: ["حساسية بنسلين", "مميعات دم", "تنبيه ثالث مهم"],
    historyAlerts: ["حساسية بنسلين", "مميعات دم", "تنبيه ثالث مهم"],
    balances: [], cleared: true, checklist: null,
    stepper: { current: "chair", steps: [{ key: "arrival", label: "وصول", done: true }] },
  };
});
const render = (extra: Partial<Parameters<typeof PatientCockpit>[0]> = {}) => {
  state.cursor = 0;
  return renderToStaticMarkup(createElement(PatientCockpit, { ...props, ...extra }));
};

describe("compact patient context presentation", () => {
  it("keeps exact identity, every alert and primary/secondary actions while avoiding another sticky overlay", () => {
    const html = render({ compact: true,
      identity: createElement("h1", null, `${props.patientName} #SYNTH-91`),
      primaryAction: createElement("button", null, "استكمال زيارة اليوم"),
      secondaryActions: createElement("button", null, "بيانات المريض والإجراءات"),
      safety: createElement("span", null, "الضغط: 185/120"),
    });
    for (const value of [props.patientName, "#SYNTH-91", "حساسية بنسلين", "مميعات دم", "تنبيه ثالث مهم", "الضغط: 185/120", "استكمال زيارة اليوم", "بيانات المريض والإجراءات"]) expect(html).toContain(value);
    expect(html).not.toContain("sticky top-0");
    expect(html).not.toContain(" …");
    expect(html).toContain("<details"); expect(html).toContain("مراحل الزيارة");
  });
  it("retains separate server-projected currencies without combining balances", () => {
    state.visit!.balances = [{ currency: "YER", dueMinor: 12000, warn: false }, { currency: "SAR", dueMinor: 3400, warn: true }];
    const html = render({ compact: true });
    expect(html).toContain(formatMoney(12000, "YER")); expect(html).toContain(formatMoney(3400, "SAR"));
    expect(html).not.toContain(formatMoney(15400, "YER"));
  });
  it("does not invent financial content when the server returns none", () => {
    const html = render({ compact: true });
    expect(html).not.toContain("عليه ");
  });
  it("renders a newly saved warning immediately beside cached independent history warnings", () => {
    const html = render({ compact: true, fallbackAlert: "حساسية جديدة محفوظة" });
    for (const value of ["حساسية جديدة محفوظة", "حساسية بنسلين", "مميعات دم", "تنبيه ثالث مهم"]) expect(html).toContain(value);
  });
  it("keeps full context available in document flow so it cannot cover Summary navigation", () => {
    const html = render();
    expect(html).not.toContain("sticky"); expect(html).toContain(props.patientName);
    expect(html).toContain('data-compact="false"');
  });
});
