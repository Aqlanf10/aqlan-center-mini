import Link from "next/link";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { SearchXIcon } from "lucide-react";
import { getI18n } from "@/i18n/server";

export default async function NotFound() {
  const { dict } = await getI18n();

  return (
    <main className="bg-muted flex min-h-svh items-center justify-center px-6">
      <EmptyState
        icon={SearchXIcon}
        title={dict.common.notFoundTitle}
        description={dict.common.notFoundHint}
      >
        <Button asChild variant="outline" className="mt-2">
          <Link href="/">{dict.common.home}</Link>
        </Button>
      </EmptyState>
    </main>
  );
}
