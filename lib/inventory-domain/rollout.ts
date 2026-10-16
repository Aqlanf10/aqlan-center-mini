import "server-only";
import { InventoryDomainError } from "./quantities";

/** Server runtime only. Never expose this setting through NEXT_PUBLIC or next.config.
 * Activation requires separately approved schema/integration work; absent or unknown
 * values fail closed. The legacy inventory does not depend on this rollout.
 */
export function inventoryIntegrationEnabled(): boolean {
  return process.env.INVENTORY_INTEGRATION_ENABLED === "true";
}

export const INVENTORY_DISABLED_MESSAGE = "المشتريات وعهد المواد غير مفعّلة حاليًا. يمكنك متابعة استخدام المخزون الحالي.";

export function requireInventoryIntegration(): void {
  if (!inventoryIntegrationEnabled()) {
    throw new InventoryDomainError("inventory_integration_disabled", INVENTORY_DISABLED_MESSAGE);
  }
}
