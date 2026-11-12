"use client";

import { usePathname } from "next/navigation";
import { useSession } from "@/components/SessionProvider";
import { CanonicalLaboratoriesDirectory } from "@/components/lab/CanonicalLaboratoriesDirectory";

/** The canonical shell admits only the exact registered /settings/laboratories route (M2
 * slice 70a): there the canonical directory replaces the legacy page and its requests.
 * Nested legacy pages (services) are not registered, so the shell refuses them. */
export default function LaboratoriesLayout({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const exact = usePathname() === "/settings/laboratories";
  return session?.canonical === true && exact ? <CanonicalLaboratoriesDirectory key={session.username} /> : children;
}
