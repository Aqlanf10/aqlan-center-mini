import { quantityAtoms, quantityText } from "@/lib/inventory-domain/quantities";
import type { readProcurementWorkbench } from "@/lib/inventory-domain/procurement-store";
type Workbench = Awaited<ReturnType<typeof readProcurementWorkbench>>;
/** Released quarantine is accepted evidence; unreleased portions stay unavailable. */
export function effectiveOrderReceipts(
  data: Pick<Workbench, "receipts" | "quarantineDispositions">,
  orderId: string,
) {
  return data.receipts
    .filter((row) => row.order_id === orderId)
    .map((row) => {
      if (row.document.disposition === "quarantined") {
        const released = (data.quarantineDispositions ?? [])
          .filter((d) => d.receipt_line_id === row.id && d.action === "release")
          .reduce((sum, d) => sum + quantityAtoms(d.base_qty, 3, true), 0n);
        if (released > 0n)
          return {
            ...row,
            document: {
              ...row.document,
              disposition: "accepted" as const,
              baseQuantity: quantityText(released),
            },
          };
      }
      return row;
    });
}
