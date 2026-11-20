import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import PatientNumberingPage from "../app/settings/patient-numbering/page";

it("reports inactive numbering settings without showing an editable form or promising an unverified next number", () => {
  const html = renderToStaticMarkup(<PatientNumberingPage />);
  expect(html).toContain('dir="rtl"');
  expect(html).toContain("تعديل الترقيم غير مفعّل");
  expect(html).not.toContain("<form");
  expect(html).not.toContain("<input");
  expect(html).not.toContain("P-07000");
});

it("mounts no numbering editor on either patient profile and does not advertise the settings editor", () => {
  for (const file of ["app/patients/[id]/page.tsx", "components/patient/CanonicalPatientProfile.tsx"]) {
    expect(readFileSync(file, "utf8")).not.toContain("PatientNumberEditor");
  }
  expect(readFileSync("app/settings/page.tsx", "utf8")).not.toContain('"/settings/patient-numbering"');
});
