"use client";

import { use } from "react";
import { PatientWorkspace } from "@/components/patient-workspace/PatientWorkspace";

/** NEW RECONSTRUCTION: route identity only; the workspace owns authority and navigation. */
export default function PatientFilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <PatientWorkspace key={id} id={id} />;
}
