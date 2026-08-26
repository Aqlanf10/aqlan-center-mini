"use client";

import { AlertCircleIcon, RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { useI18n } from "@/i18n/provider";

/** Route-level error boundary for the authenticated app shell. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { dict } = useI18n();

  // Error details are logged for diagnostics; never rendered to the user.
  console.error("[app-error]", error);

  return (
    <EmptyState
      icon={AlertCircleIcon}
      title={dict.common.error}
      description={dict.common.errorHint}
    >
      <Button onClick={reset} variant="outline" className="mt-2">
        <RotateCcwIcon aria-hidden="true" />
        {dict.common.retry}
      </Button>
    </EmptyState>
  );
}
