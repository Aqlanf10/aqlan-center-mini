"use client";

import { usePathname } from "next/navigation";
import { useSession } from "@/components/SessionProvider";
import { CanonicalLabServicesPage } from "@/components/lab/CanonicalLabServicesPage";

/** M2 slice 70b: the canonical services catalogue replaces the legacy page and its
 * requests on the exact registered path. */
export default function LabServicesLayout({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const exact = usePathname() === "/settings/lab-services";
  return session?.canonical === true && exact ? <CanonicalLabServicesPage key={session.username} /> : children;
}
