import type { ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), use: () => ({ id: "91001" }) }));
vi.mock("../components/ClinicalVisit", () => ({ ClinicalVisit: () => null }));
vi.mock("../components/PageHeader", () => ({ PageHeader: () => null }));
// M2 slice 84: the page reads the session to choose the canonical cockpit.
const session = vi.hoisted(() => ({ value: null as null | { canonical?: boolean } }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => session.value }));
vi.mock("../components/CanonicalVisitClinical", () => ({ CanonicalVisitClinical: () => null }));
import VisitPage from "../app/visits/[id]/page";
import { ClinicalVisit } from "../components/ClinicalVisit";
import { CanonicalVisitClinical } from "../components/CanonicalVisitClinical";
afterEach(() => { vi.unstubAllGlobals(); session.value = null; });
it("retains the exact signed visit when navigating to the patient checkout", () => {
  const location = { href: "" };
  vi.stubGlobal("window", { location });
  const tree = VisitPage({ params: Promise.resolve({ id: "91001" }) });
  const clinical = (tree.props.children as ReactElement<{ onSigned: (result: {patientId:number}) => void }>[])
    .find(child => child.type === ClinicalVisit)!;
  clinical.props.onSigned({ patientId: 92001 });
  expect(location.href).toBe("/patients/92001?tab=today&checkoutVisit=91001");
});

it("a canonical account gets the canonical cockpit for the same visit, never the legacy screen", () => {
  session.value = { canonical: true };
  const tree = VisitPage({ params: Promise.resolve({ id: "91001" }) });
  const children = tree.props.children as ReactElement<{ visitId: number }>[];
  expect(children.find(child => child.type === ClinicalVisit)).toBeUndefined();
  expect(children.find(child => child.type === CanonicalVisitClinical)?.props.visitId).toBe(91001);
});
