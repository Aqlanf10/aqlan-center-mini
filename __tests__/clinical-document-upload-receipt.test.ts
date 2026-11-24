import { describe, expect, it } from "vitest";
import { projectUploadedClinicalDocument } from "../lib/clinical-document-upload-receipt";

// All values are synthetic. Do not use patient images or identifiers in tests.
describe("P0 receptionist clinical upload-only receipt", () => {
  const saved = {
    id: 63,
    patientId: 11,
    title: "Synthetic protected cephalogram",
    note: "Synthetic private radiology interpretation",
    storageKey: "synthetic-clinical-blob-key",
    fileUrl: "/api/documents/63",
    sha256: "synthetic-content-hash",
    uploadedBy: "synthetic-clinician",
    width: 1920,
    height: 1080,
    metadata: { visitId: 7, findings: "Synthetic confidential finding" },
  };

  it("returns a generic acknowledgement only to reception, without any nested clinical data", () => {
    const receipt = projectUploadedClinicalDocument("reception", saved);
    expect(receipt).toEqual({ uploaded: true });
    expect(Object.keys(receipt)).toEqual(["uploaded"]);
    const body = JSON.stringify(receipt);
    for (const value of [
      saved.id, saved.patientId, saved.title, saved.note, saved.storageKey,
      saved.fileUrl, saved.sha256, saved.uploadedBy, saved.metadata.findings,
    ]) {
      expect(body).not.toContain(String(value));
    }
    expect(receipt).not.toBe(saved);
  });

  it("does not alter the stored document record", () => {
    projectUploadedClinicalDocument("reception", saved);
    expect(saved.metadata.visitId).toBe(7);
    expect(saved.fileUrl).toBe("/api/documents/63");
  });

  it.each(["admin", "doctor"])("preserves authorized clinical response for %s", (role) => {
    expect(projectUploadedClinicalDocument(role, saved)).toBe(saved);
  });
});
