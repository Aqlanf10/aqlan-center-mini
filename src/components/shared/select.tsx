"use client";

import { cn } from "@/lib/utils";

export type SelectOption = { value: string; label: string };

/**
 * Styled native <select>. Native selects are dependency-free, fully
 * accessible, keyboard-navigable and behave best on mobile — ideal for
 * the small filter/enum selects in this app.
 */
export function Select({
  id,
  name,
  value,
  defaultValue,
  onChange,
  options,
  disabled,
  className,
  ariaLabel,
  placeholder,
  children,
}: {
  id?: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  options?: SelectOption[];
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  placeholder?: string;
  /** Alternative to `options`: inline <option> children. */
  children?: React.ReactNode;
}) {
  return (
    <select
      id={id}
      name={name}
      value={value}
      defaultValue={defaultValue}
      onChange={onChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "border-input bg-background dark:bg-input/30 dark:border-input flex h-9 w-full min-w-0 rounded-md border px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
    >
      {placeholder !== undefined ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {options
        ? options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))
        : children}
    </select>
  );
}
