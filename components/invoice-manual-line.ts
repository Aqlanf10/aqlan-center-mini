import { replaceRowService, type ToothRowLike } from "./dental/invoice-tooth-selection";

/** Invoice row fields the free manual line touches. `manual` is explicit UI state, never a service id. */
export type ManualLineRow = ToothRowLike & {
  serviceId: string; doctorId: string; description: string; price: string; priceReason: string; manual?: boolean;
};

/**
 * Selecting «بند يدوي حر». Re-selecting it (or re-rendering) keeps the typed description and price.
 * Leaving a catalogue service drops that service's name, price, price reason, doctor and tooth/case
 * linkage, so nothing from it leaks into the manual line. The owner clears catalogue-origin fields
 * when entering the empty choice; only text/amounts typed there are retained on entry to manual.
 * The manual line is sent without a serviceId, exactly as before; pricing authority stays on the server.
 */
export function selectManualLine<R extends ManualLineRow>(rows: readonly R[], index: number): R[] {
  const row = rows[index];
  if (!row || row.manual) return [...rows];
  if (row.serviceId === "") return rows.map((item, i) => i === index ? { ...item, manual: true } : item);
  return replaceRowService(rows, index,
    { manual: true, serviceId: "", doctorId: "", priceReason: "", description: "", price: "" } as Partial<R>, "none");
}
