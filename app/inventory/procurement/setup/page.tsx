import { InventoryReferenceSetup } from "@/components/inventory/InventoryReferenceSetup";
import { InventoryIntegrationDisabled } from "@/components/inventory/InventoryIntegrationDisabled";
import { inventoryIntegrationEnabled } from "@/lib/inventory-domain/rollout";
export const dynamic = "force-dynamic";
export default function Page() {
  return inventoryIntegrationEnabled() ? (
    <InventoryReferenceSetup />
  ) : (
    <InventoryIntegrationDisabled />
  );
}
