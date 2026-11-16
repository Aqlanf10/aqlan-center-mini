"use client";

import { useSession } from "@/components/SessionProvider";
import { CanonicalLabBoard } from "@/components/lab/CanonicalLabBoard";

/** The canonical shell admits only the exact registered /lab route (M2 slice 66). Never
 * mount the legacy lab page (or its unrelated requests and writes) for that session. */
export default function LabLayout({ children }: { children: React.ReactNode }) {
  const session = useSession();
  return session?.canonical === true ? <CanonicalLabBoard key={session.username} /> : children;
}
