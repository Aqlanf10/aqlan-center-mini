"use client";

import type { ReactNode } from "react";

import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import type { Dictionary } from "@/i18n/dictionaries/ar";

/**
 * Shared form primitives: labeled field wrapper + inline bilingual
 * validation errors keyed by dictionary paths.
 */

/** Resolve "a.b.c" dictionary paths for validation messages. */
export function dictPath(dict: Dictionary, path: string): string {
  const segments = path.split(".");
  let current: unknown = dict;
  for (const segment of segments) {
    if (
      current &&
      typeof current === "object" &&
      segment in (current as Record<string, unknown>)
    ) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return dict.errors.generic;
    }
  }
  return typeof current === "string" ? current : dict.errors.generic;
}

export function FormField({
  id,
  label,
  error,
  hint,
  required,
  children,
  className,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cnField(className)}>
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span className="text-destructive" aria-hidden="true">
            {" *"}
          </span>
        ) : null}
      </Label>
      {children}
      {hint && !error ? (
        <p className="text-muted-foreground text-xs">{hint}</p>
      ) : null}
      {error ? (
        <p
          id={`${id}-error`}
          className="text-destructive text-sm"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Translate a field-error key through the active dictionary. */
export function useFieldError() {
  const { dict } = useI18n();
  return (key: string | undefined) =>
    key ? dictPath(dict, key) : undefined;
}

function cnField(className?: string) {
  return [
    "flex flex-col gap-1.5",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}
