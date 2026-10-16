import Link from "next/link";
import { INVENTORY_DISABLED_MESSAGE } from "@/lib/inventory-domain/rollout";

export function InventoryIntegrationDisabled() {
  return <main dir="rtl" className="mx-auto max-w-3xl p-6" data-testid="inventory-integration-disabled">
    <h1 className="text-xl font-bold">المشتريات والعهد غير مفعّلة</h1>
    <p className="my-4">{INVENTORY_DISABLED_MESSAGE}</p>
    <Link href="/inventory" className="underline">العودة إلى المخزون</Link>
  </main>;
}
