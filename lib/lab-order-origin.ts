import type { LabOrderClinicalDTO } from "./lab";

/** "manual" also covers direct invoices. Never infer visit provenance from
 * needed status or an incidental visit link on a manually created order. */
export function labOrderOriginLabel(order: Pick<LabOrderClinicalDTO, "source" | "visitId">): string | null {
  return order.source === "auto" && Number.isSafeInteger(order.visitId) && Number(order.visitId) > 0
    ? "من الزيارة"
    : null;
}
