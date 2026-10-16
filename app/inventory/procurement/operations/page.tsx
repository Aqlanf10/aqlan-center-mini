import { ProcurementOperations } from "@/components/inventory/ProcurementOperations";
import { InventoryIntegrationDisabled } from "@/components/inventory/InventoryIntegrationDisabled";
import { inventoryIntegrationEnabled } from "@/lib/inventory-domain/rollout";

export const dynamic = "force-dynamic";
export default function Page() {
  if (!inventoryIntegrationEnabled()) return <InventoryIntegrationDisabled />;
  return <ProcurementOperations />;
}
