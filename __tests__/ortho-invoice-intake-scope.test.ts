import { describe, expect, it } from "vitest";
import { verifiedInvoiceOrthoArches } from "@/components/PatientOrtho";

const pending = { id: 11, patientId: 8, kind: "specialty", orthoCaseId: null, specialty: "orthodontics",
  origin: "invoice", needsAssessment: true, status: "waiting", site: "الفك السفلي" };

describe("verified billed orthodontic arch", () => {
  it.each([["الفك السفلي", "lower"], ["الفك العلوي", "upper"], ["الفكّان", "both"], ["lower", "lower"]])(
    "uses the exact site's canonical arch (%s)", (site, arches) => {
      expect(verifiedInvoiceOrthoArches({ cases: [{ ...pending, id: 12 }, { ...pending, site }] }, 8, 11)).toBe(arches);
    },
  );
  it.each([{ site: "possibly lower" }, { site: "full_mouth" }, { patientId: 9 }, { id: 12 },
    { status: "closed" }, { orthoCaseId: 4 }, { needsAssessment: false }, { origin: "clinical" }])(
    "does not guess an arch from unconfirmed material (%j)", (changes) => {
      expect(verifiedInvoiceOrthoArches({ cases: [{ ...pending, ...changes }] }, 8, 11)).toBeNull();
    },
  );
  it("does not choose from duplicated exact identities", () => {
    expect(verifiedInvoiceOrthoArches({ cases: [pending, pending] }, 8, 11)).toBeNull();
  });
});
