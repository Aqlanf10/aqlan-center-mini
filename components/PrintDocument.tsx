import type { HTMLAttributes, ReactNode } from "react";
import { Logo } from "./Icon";
export { PrintDocumentWatermark } from "./PrintDocumentWatermark";

/** Presentation only. The caller owns rows, columns, amounts, access and scope.
 * A normal-flow frame allows long tables to paginate; the decorative logo never
 * enters the table model or repeats financial totals. Do not wrap anatomy or
 * pagination/layout tables. */
export function PrintTableFrame({ children, className = "", printOnly = false, screenFrame = false, ...attributes }: {
  children: ReactNode; printOnly?: boolean; screenFrame?: boolean;
} & HTMLAttributes<HTMLDivElement>) {
  return <div {...attributes} className={`print-table-frame${printOnly ? " print-table-frame-on-print" : ""}${screenFrame ? " print-table-screen-frame" : ""} ${className}`.trim()}>
    <div className="print-table-watermark" aria-hidden="true"><Logo /></div>
    {children}
  </div>;
}

/** Existing label/value blocks form compact paired rows, in their original RTL
 * order. No values are inferred, formatted, hidden or recalculated here. */
export function PrintMetadata({ children, className = "", printOnly = false }: {
  children: ReactNode; className?: string; printOnly?: boolean;
}) {
  return <div className={`print-metadata${printOnly ? " print-metadata-on-print" : ""} ${className}`.trim()}>{children}</div>;
}
