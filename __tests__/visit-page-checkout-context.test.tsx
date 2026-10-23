import type { ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), use: () => ({ id: "91001" }) }));
vi.mock("../components/ClinicalVisit", () => ({ ClinicalVisit: () => null }));
vi.mock("../components/PageHeader", () => ({ PageHeader: () => null }));
import VisitPage from "../app/visits/[id]/page";
import { ClinicalVisit } from "../components/ClinicalVisit";
afterEach(() => vi.unstubAllGlobals());
it("retains the exact signed visit when navigating to the patient checkout", () => {
  const location = { href: "" };
  vi.stubGlobal("window", { location });
  const tree = VisitPage({ params: Promise.resolve({ id: "91001" }) });
  const clinical = (tree.props.children as ReactElement<{ onSigned: (result: {patientId:number}) => void }>[])
    .find(child => child.type === ClinicalVisit)!;
  clinical.props.onSigned({ patientId: 92001 });
  expect(location.href).toBe("/patients/92001?tab=today&checkoutVisit=91001");
});
