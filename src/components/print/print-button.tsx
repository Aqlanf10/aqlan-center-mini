"use client";

import { PrinterIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";

/** Floating print button — hidden by @media print. */
export function PrintButton() {
  const { dict } = useI18n();
  return (
    <div className="print-hide fixed inset-x-0 bottom-4 z-50 flex justify-center">
      <Button onClick={() => window.print()} size="lg">
        <PrinterIcon aria-hidden="true" />
        {dict.print.printButton}
      </Button>
    </div>
  );
}
