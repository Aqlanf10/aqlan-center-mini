import { describe, expect, it } from "vitest";
import { clinicalCaseCompatibility, planItemClinicalScope, type ClinicalCaseIdentity } from "@/lib/clinical-case-linkage";
import { caseSiteFits, lineLinkage, validateLineSite } from "@/lib/invoice-clinical-linkage";

const item = { serviceId: 1, category: "rct", toothCode: 36, surfaces: null };
const target: ClinicalCaseIdentity = { patientId: 7, specialty: "endodontics", status: "active", site: "36" };
const scope = planItemClinicalScope(item)!;
const compatible = (patch: Partial<typeof target>) => clinicalCaseCompatibility({ patientId: 7, ...scope, target: { ...target, ...patch } });

describe("canonical clinical case identity", () => {
  it("shares invoice category and FDI/site rules, without financial behavior", () => {
    expect(compatible({})).toBeNull();
    expect(compatible({ patientId: 8 })).toBe("bad_case");
    expect(compatible({ specialty: "prosthodontics" })).toBe("wrong_specialty");
    expect(compatible({ site: "11" })).toBe("wrong_site");
    expect(compatible({ site: null })).toBe("scope_unknown");
    for (const status of ["completed", "closed", "cancelled"]) expect(compatible({ status })).toBe("closed");
    expect(compatible({ status: "waiting" })).toBeNull();
  });
  it("requires authoritative scope rather than parsing notes or guessing from a new target", () => {
    for (const category of ["ortho", "crown", "bridge", "veneer"]) {
      const unresolved = planItemClinicalScope({ ...item, category });
      expect(unresolved?.site).toBeNull();
    }
    expect(planItemClinicalScope({ ...item, category: "unknown" })).toBeNull();
    expect(planItemClinicalScope({ ...item, serviceId: null })).toBeNull();
    expect(planItemClinicalScope({ ...item, toothCode: 99 })?.site).toBeNull();
    expect(planItemClinicalScope({ ...item, category: "cleaning", toothCode: null })?.site).toBeNull();
  });
  it("uses the exact invoice matcher for all authoritative LineSite inputs", () => {
    const inputs = [
      { category: "rct", toothCode: 36 },
      { category: "crown", toothCode: 36, episodeTeeth: [36, 37] },
      { category: "ortho", toothCode: null, scope: "upper" },
      { category: "cleaning", toothCode: null, scope: "full_mouth" },
    ];
    for (const input of inputs) {
      const checked = validateLineSite(input);
      const linkage = lineLinkage({ serviceId: 1, category: input.category });
      if (!checked.ok || linkage.kind !== "clinical") throw new Error("invalid synthetic fixture");
      for (const site of ["36", "11", "36، 37", "upper", "lower", "full_mouth", "الفك العلوي"]) {
        const refusal = clinicalCaseCompatibility({ patientId: 7, specialty: linkage.specialty, site: checked.site,
          target: { ...target, specialty: linkage.specialty, site } });
        expect(refusal === null).toBe(caseSiteFits(linkage.specialty, site, checked.site));
      }
    }
  });
  it("rejects inactive, missing, or foreign Ortho bridges before unresolved scope", () => {
    for (const ortho of [null, { patientId: 7, status: "completed" }, { patientId: 8, status: "active" }]) {
      expect(clinicalCaseCompatibility({ patientId: 7, specialty: "orthodontics", site: null,
        target: { ...target, specialty: "orthodontics", ortho } })).toBe("closed");
    }
  });
});
