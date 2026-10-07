import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Odontogram, OdontogramRow } from "../components/dental/Odontogram";
import { SurfaceSelector, toggleSurface } from "../components/dental/SurfaceSelector";
import { ToothSelectionDialog } from "../components/dental/ToothSelectionDialog";
import {
  PER_TOOTH_SPLIT_NOTICE, TOOTH_REQUIRED_MESSAGE, applyToothSelection, emptyToothFields, invoiceToothMode, removeRowAt,
  replaceRowService, selectionLabel, selectionOfRow, setRowScope, toothPayload, toothProblem, usesToothChart,
  type ToothRowLike,
} from "../components/dental/invoice-tooth-selection";
import { PERMANENT_LOWER, PERMANENT_UPPER, buildChart, toothName } from "../lib/dental";

/**
 * (INV-LINK TOOTH) أسنان بند الفاتورة من مخطط الأسنان المشترك.
 * المنطق الخالص مباشرةً، والعرض عبر renderToStaticMarkup (لا jsdom في المستودع).
 */

type Row = ToothRowLike & { serviceId: string; price: string };
let seq = 0;
const key = () => `k${++seq}`;
const row = (patch: Partial<Row> = {}): Row => ({
  key: key(), serviceId: "7", price: "100", caseId: "", ...emptyToothFields("none"), ...patch,
});

describe("(INV-LINK TOOTH) mode from the service category", () => {
  it("maps categories through the shared contract and rejects raw/prototype names", () => {
    expect(invoiceToothMode("rct")).toBe("per_tooth_episode");
    expect(invoiceToothMode("bridge")).toBe("multi_tooth_episode");
    expect(invoiceToothMode("filling")).toBe("tooth_surfaces");
    expect(invoiceToothMode("cleaning")).toBe("region");
    expect(invoiceToothMode("ortho")).toBe("arch");
    expect(invoiceToothMode("consultation")).toBe("none");
    for (const raw of ["constructor", "__proto__", "toString", "", null, undefined]) expect(invoiceToothMode(raw)).toBe("none");
    expect(usesToothChart("arch")).toBe(false);
    expect(usesToothChart("none")).toBe(false);
    expect(usesToothChart("region")).toBe(true);
  });
});

describe("(INV-LINK TOOTH) chart selection → invoice lines", () => {
  it("RCT on 36 and 46 splits into one line per tooth (same service, price), never one line for two teeth", () => {
    const first = row({ price: "250" });
    const other = row({ serviceId: "9" });
    const rows = applyToothSelection([first, other], 0, "per_tooth_episode", { teeth: [46, 36], surfaces: "", scope: null }, key);
    expect(rows.map((one) => [one.serviceId, one.price, one.toothCode, one.episodeTeeth])).toEqual([
      ["7", "250", 36, null], ["7", "250", 46, null], ["9", "100", null, null],
    ]);
    expect(rows[0].key).toBe(first.key);
    expect(new Set(rows.map((one) => one.key)).size).toBe(3);
    expect(rows.map((one) => toothPayload("per_tooth_episode", one))[1]).toEqual({ toothCode: 46 });
    expect(PER_TOOTH_SPLIT_NOTICE).toBe("سيُنشأ سطر وحالة مستقلة لكل سن");
  });

  it("crown/bridge 14,15,16 ⇒ three lines that all carry the whole episode; editing the episode replaces it", () => {
    const rows = applyToothSelection([row({ price: "90" })], 0, "multi_tooth_episode", { teeth: [16, 14, 15], surfaces: "", scope: null }, key);
    expect(rows.map((one) => one.toothCode)).toEqual([14, 15, 16]);
    expect(rows.every((one) => one.groupId && one.groupId === rows[0].groupId)).toBe(true);
    expect(rows.map((one) => toothPayload("multi_tooth_episode", one))).toEqual([
      { toothCode: 14, episodeTeeth: [14, 15, 16] }, { toothCode: 15, episodeTeeth: [14, 15, 16] }, { toothCode: 16, episodeTeeth: [14, 15, 16] },
    ]);
    expect(selectionLabel("multi_tooth_episode", rows[1])).toBe("جسر/حلقة: 14، 15، 16");
    expect(selectionOfRow(rows[2]).teeth).toEqual([14, 15, 16]);

    const priced = rows.map((one) => one.toothCode === 15 ? { ...one, price: "120" } : one);
    const edited = applyToothSelection(priced, 2, "multi_tooth_episode", { teeth: [15, 16, 17], surfaces: "", scope: null }, key);
    expect(edited.map((one) => [one.toothCode, one.price])).toEqual([[15, "120"], [16, "90"], [17, "90"]]);
    expect(edited.every((one) => JSON.stringify(one.episodeTeeth) === "[15,16,17]")).toBe(true);
    expect(new Set(edited.map((one) => one.key)).size).toBe(3);
  });

  it("removing a line of an episode updates the rest; a single remaining tooth is no longer grouped", () => {
    const rows = applyToothSelection([row()], 0, "multi_tooth_episode", { teeth: [14, 15], surfaces: "", scope: null }, key);
    const left = removeRowAt(rows, 1);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ toothCode: 14, episodeTeeth: [14], groupId: null });
    const changed = replaceRowService(rows, 0, { serviceId: "3" }, "per_tooth_episode");
    expect(changed[0]).toMatchObject({ serviceId: "3", toothCode: null, episodeTeeth: null, groupId: null });
    expect(changed[1]).toMatchObject({ toothCode: 15, episodeTeeth: [15], groupId: null });
  });

  it("filling: one tooth with canonical surfaces; the payload sends them", () => {
    const [filled] = applyToothSelection([row()], 0, "tooth_surfaces", { teeth: [26], surfaces: "OM", scope: null }, key);
    expect(filled).toMatchObject({ toothCode: 26, surfaces: "MO" });
    expect(toothPayload("tooth_surfaces", filled)).toEqual({ toothCode: 26, surfaces: "MO" });
    expect(selectionLabel("tooth_surfaces", filled)).toBe("سن 26 — أسطح MO");
    expect(toggleSurface(["M"], "O")).toEqual(["M", "O"]);
    expect(toggleSurface(["M", "O"], "M")).toEqual(["O"]);
  });

  it("ortho arch and cleaning region use scopes, not a tooth", () => {
    const [ortho] = setRowScope([row(emptyToothFields("arch"))], 0, "upper");
    expect(toothPayload("arch", ortho)).toEqual({ scope: "upper" });
    expect(selectionLabel("arch", ortho)).toBe("الفك العلوي");
    expect(toothProblem("arch", row())).toBeNull();
    const cleaning = row(emptyToothFields("region"));
    expect(toothPayload("region", cleaning)).toEqual({ scope: "full_mouth" });
    const [onTooth] = applyToothSelection([cleaning], 0, "region", { teeth: [16], surfaces: "", scope: "full_mouth" }, key);
    expect(toothPayload("region", onTooth)).toEqual({ toothCode: 16 });
    const [back] = setRowScope([onTooth], 0, "lower");
    expect(toothPayload("region", back)).toEqual({ scope: "lower" });
    // نطاقٌ لا يسمح به النمط لا يُرسل
    expect(toothPayload("arch", { ...ortho, scope: "full_mouth" })).toEqual({ scope: undefined });
  });

  it("fails closed: a tooth-required line without a tooth is a problem; consultation sends nothing", () => {
    expect(toothProblem("per_tooth_episode", row())).toBe(TOOTH_REQUIRED_MESSAGE);
    expect(toothProblem("multi_tooth_episode", row())).toBe(TOOTH_REQUIRED_MESSAGE);
    expect(toothProblem("tooth_surfaces", row())).toBe(TOOTH_REQUIRED_MESSAGE);
    expect(toothProblem("per_tooth_episode", row({ toothCode: 36 }))).toBeNull();
    expect(toothProblem("region", row())).toBeNull();
    expect(toothPayload("none", row({ toothCode: 36 }))).toEqual({});
  });
});

describe("(INV-LINK TOOTH) one shared odontogram", () => {
  it("renders the same SVG tooth buttons with FDI labels, selection state and stable test ids", () => {
    const chart = buildChart([{ id: 1, toothCode: 36, condition: "rct", stage: "existing", surfaces: null, note: null,
      recordedBy: "x", recordedAt: "2026-10-05T12:00:00Z", visitId: null }]);
    const html = renderToStaticMarkup(createElement(Odontogram, { chart, selected: [36, 46], onPick: () => undefined, touch: true }));
    expect(html.match(/<button /g)).toHaveLength(32);
    expect(html).toContain('data-testid="odontogram-tooth-36"');
    expect(html).toContain(`aria-label="${toothName(36)}"`);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html).toContain("fill-purple-500"); // حالة السن الحقيقية (علاج عصب)
    expect(html).toContain("min-h-[44px]");
    const row = renderToStaticMarkup(createElement(OdontogramRow, { teeth: PERMANENT_UPPER, chart, selected: [], onPick: () => undefined }));
    expect(row).toContain('dir="ltr"');
    expect(row).not.toContain("min-h-[44px]");
    expect(PERMANENT_LOWER).toContain(46);
  });

  it("DentalChart and the invoice dialog import the shared pieces — no private copy of the tooth row", () => {
    const chartSource = readFileSync(resolve(__dirname, "../components/DentalChart.tsx"), "utf8");
    const dialogSource = readFileSync(resolve(__dirname, "../components/dental/ToothSelectionDialog.tsx"), "utf8");
    expect(chartSource).toContain('from "./dental/Odontogram"');
    expect(chartSource).toContain('from "./dental/SurfaceSelector"');
    expect(dialogSource).toContain('from "./Odontogram"');
    expect(dialogSource).toContain('from "./SurfaceSelector"');
    for (const source of [chartSource, dialogSource]) {
      expect(source).not.toMatch(/const CONDITION_COLOR|function Row\(|SURFACE_DESCRIPTIONS: Record/);
      expect(source).not.toContain("M12 2c-3 0-4.3 1.4");
    }
    expect(dialogSource).toContain("toggleTooth");
    expect(dialogSource).toContain("buildChart");
  });

  it("surface selector and dialog markup", () => {
    const surfaces = renderToStaticMarkup(createElement(SurfaceSelector, { value: ["M"], onChange: () => undefined }));
    expect(surfaces).toContain('data-testid="surface-M"');
    expect(surfaces).toContain("إنسي (Mesial)");
    expect(surfaces.match(/aria-pressed="true"/g)).toHaveLength(1);
    const dialog = renderToStaticMarkup(createElement(ToothSelectionDialog, {
      patientId: 1, mode: "per_tooth_episode", serviceName: "علاج عصب", initial: { teeth: [36, 46], surfaces: "", scope: null },
      onConfirm: () => undefined, onCancel: () => undefined,
    }));
    expect(dialog).toContain('role="dialog"');
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain("aria-labelledby");
    expect(dialog).toContain("تحديد الأسنان — علاج عصب");
    expect(dialog).toContain('data-testid="tooth-dialog-split-notice"');
    expect(dialog).toContain('data-testid="tooth-dialog-confirm"');
  });
});
