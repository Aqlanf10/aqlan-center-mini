"use client";

import { useState } from "react";

/** One decorative image at the app body boundary, never one per header/table.
 * Print CSS repeats this fixed image on continuation pages. No patient data,
 * generated logo, background-graphics dependency, or financial projection. */
export function PrintDocumentWatermark({ src = "/logo.png" }: { src?: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="print-document-watermark" aria-hidden="true" data-logo-state={!src || failed ? "unavailable" : "ready"}>
    {src && !failed ? <img className="print-document-watermark-image" src={src} alt="" draggable={false} onError={() => setFailed(true)} /> : null}
  </div>;
}
