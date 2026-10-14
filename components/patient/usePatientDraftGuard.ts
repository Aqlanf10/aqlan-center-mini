"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

export type RegisterPatientDraftGuard = (guard: () => boolean) => () => void;

/** Registers with the existing patient navigation controller, never a second router. */
export function usePatientDraftGuard(dirty: boolean, busy: boolean, register?: RegisterPatientDraftGuard) {
  const current = useRef({ dirty, busy });
  useLayoutEffect(() => { current.current = { dirty, busy }; }, [dirty, busy]);
  useEffect(() => register?.(() => !current.current.busy && (!current.current.dirty
    || window.confirm("هناك بيانات غير محفوظة في هذا القسم. هل تريد تجاهلها ومغادرة القسم؟"))), [register]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (current.current.dirty || current.current.busy) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
}
