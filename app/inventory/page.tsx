import InventoryOverview from "@/components/inventory/InventoryOverview";
import { inventoryIntegrationEnabled } from "@/lib/inventory-domain/rollout";

export const dynamic = "force-dynamic";
export default function InventoryPage() {
  return <InventoryOverview integrationEnabled={inventoryIntegrationEnabled()} />;
}
