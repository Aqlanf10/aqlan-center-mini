import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { categoryDisplayName, normalizeCategory, ServiceSelect } from "../components/ServiceSelect";

describe("reachable raw service category display", () => {
  it.each(["constructor", "Constructor", "toString", "__proto__", "hasOwnProperty"])(
    "preserves unknown raw %s as a string through normalization and labeling", (category) => {
      expect(normalizeCategory(category)).toBe(category);
      expect(categoryDisplayName(category)).toBe(category);
    },
  );

  it.each(["constructor", "Constructor", "toString", "__proto__", "hasOwnProperty"])(
    "renders the selected service and its raw %s group without dispatching a selection", (category) => {
      const onChange = vi.fn();
      const html = renderToStaticMarkup(createElement(ServiceSelect, {
        services: [{ id: 37, name: "خدمة بفئة حرة", category, priceMinor: 12500 }],
        value: 37, onChange,
      }));
      expect(html).toContain(`label="❖ ${category}"`);
      expect(html).toContain(`>${category}</span>`);
      expect(html).toContain('value="37" selected=""');
      expect(html).not.toMatch(/function Object|function toString|\[object Object\]|native code/);
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["RCT", "rct", "⚡ علاج الجذور والعصب"],
    ["علاج جذور", "rct", "⚡ علاج الجذور والعصب"],
    ["فحص واستشارة", "consultation", "🔍 فحص وتشخيص"],
    ["فئة حرة", "فئة حرة", "فئة حرة"],
  ])("retains existing known and legacy presentation for %s", (raw, normalized, label) => {
    expect(normalizeCategory(raw)).toBe(normalized);
    expect(categoryDisplayName(normalized)).toBe(label);
  });
});
