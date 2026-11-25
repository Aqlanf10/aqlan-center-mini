"use client";

import { OwnerPatientNumberingEditor } from "./OwnerPatientNumberingEditor";
import type { OwnerNumberingPort } from "@/lib/patients/numbering-owner-editor";

/**
 * Default-closed presentation seam. Never derive a numbering transport from
 * the Settings shell's role. Only a separately reviewed owner composition in
 * the same client tree may supply a bound port.
 */
export function PatientNumberingSettingsSlot({ port = null }: { port?: OwnerNumberingPort | null }) {
  if (!port) return null;
  return <div className="mb-3"><OwnerPatientNumberingEditor port={port} /></div>;
}
