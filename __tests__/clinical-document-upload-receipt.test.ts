import { describe, expect, it } from "vitest";
import { projectUploadedClinicalDocument } from "../lib/clinical-document-upload-receipt";

// Pure synthetic data; this does not read clinic storage or databases.
describe("P0 upload-only clinical document receipt", () => {
  const saved = {
    id: 63, patientId: 11, title: "synthetic protected radiograph",
    note: "synthetic clinical report", storageKey: "synthetic-blob-key",
    sha256: "synthetic-digest", uploadedBy: "synthetic-staff",
    width: 1920, height: 1080,
  };

  it("returns only a generic acknowledgement to reception regardless of legacy grants", () => {
    const receipt = projectUploadedClinicalDocument("reception", saved);
    expect(receipt).toEqual({ uploaded: true });
    for (const protectedValue of [saved.title, saved.note, saved.storageKey, saved.sha256]) {
      expect(JSON.stringify(receipt)).not.toContain(protectedValue);
    }
    expect(receipt).not.toHaveProperty("id");
    expect(receipt).not.toHaveProperty("patientId");
  });

  it.each(["admin", "doctor"])("preserves documented post-save metadata for clinical role %s", role => {
    expect(projectUploadedClinicalDocument(role, saved)).toBe(saved);
  });
});
