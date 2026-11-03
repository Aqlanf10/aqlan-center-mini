import { Fragment, type CSSProperties, type ReactNode } from "react";

/** One anatomical row, always patient-right to patient-left, independent of UI RTL.
 * No client boundary: the same primitive is used by interactive charts and server print.
 * Specialty renderers own their overlays and callbacks; persisted FDI IDs never change. */
export function DentalArchRow({ teeth, renderTooth, className = "flex gap-0.5", style, label }: {
  teeth: readonly number[];
  renderTooth: (code: number, index: number) => ReactNode;
  className?: string;
  style?: CSSProperties;
  label?: string;
}) {
  const midIndex = teeth.length >= 2 && teeth.length % 2 === 0 ? teeth.length / 2 - 1 : -1;
  return <div data-dental-arch={teeth.join(",")} dir="ltr" role="group" aria-label={label}
    className={className} style={style}>
    {teeth.map((code, index) => (
      <Fragment key={code}>
        {renderTooth(code, index)}
        {index === midIndex ? <span aria-hidden="true" data-dental-midline="true" className="mx-1 self-stretch w-px bg-slate-300" /> : null}
      </Fragment>
    ))}
  </div>;
}
