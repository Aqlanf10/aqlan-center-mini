import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrescriptionMedicationLibrary } from "@/components/PrescriptionMedicationLibrary";
import { MEDICATION_REFERENCES } from "@/lib/prescription-medication-library";
import { MEDICATION_TEMPLATES } from "@/lib/prescription-medication-templates";

// Review cards must never become automatically usable prescription regimens.
describe("medication library review gate", () => {
  it("exposes exactly four sourced entries, all pending, with no executable seed", () => {
    expect(MEDICATION_REFERENCES).toHaveLength(4);
    expect(MEDICATION_TEMPLATES).toEqual([]);
    for (const entry of MEDICATION_REFERENCES) {
      expect(entry.reviewStatus).toBe("pending-owner-review");
      expect(entry.units).toBeTruthy();
      expect(entry.sources.every(s => s.url.startsWith("https://") && s.version.length > 0)).toBe(true);
    }
  });
  it("renders review status and disables every add button", () => {
    const html = renderToStaticMarkup(<PrescriptionMedicationLibrary />);
    expect(html).toContain('data-medication-library="review-only"');
    expect(html.match(/<button type="button" disabled=""/g)).toHaveLength(4);
    expect(html).not.toContain("Clindamycin");
    expect(html).not.toContain("Azithromycin");
  });
});
