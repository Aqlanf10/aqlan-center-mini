"use client";

import { usePathname } from "next/navigation";
import { useSession } from "@/components/SessionProvider";
import { CanonicalLabPricingPage } from "@/components/lab/CanonicalLabPricingPage";

/** M2 slice 70b: the canonical pricing page replaces the legacy page and its requests on
 * the exact registered path. Cost prices are requested only with finance.cost-prices.view. */
export default function LabPricingLayout({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const exact = usePathname() === "/settings/lab-pricing";
  return session?.canonical === true && exact ? <CanonicalLabPricingPage key={session.username} /> : children;
}
