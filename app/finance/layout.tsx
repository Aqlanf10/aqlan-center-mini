"use client";

import { useSession } from "@/components/SessionProvider";
import { CanonicalShifts } from "@/components/finance/CanonicalShifts";

/** The canonical shell admits only the exact registered /finance route. Never
 * mount the legacy finance page (or its unrelated requests) for that session. */
export default function FinanceLayout({ children }: { children: React.ReactNode }) {
  const session = useSession();
  return session?.canonical === true
    ? <CanonicalShifts key={session.username} username={session.username} />
    : children;
}
