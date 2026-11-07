import { isDocumentAcquisitionDate } from "./document-acquisition-date";
/** Exact Gregorian date-only input. No current-clock, past/future, or clinical restriction. */
export const isAdjustmentDate = isDocumentAcquisitionDate;
export const ADJUSTMENT_DATE_ERROR = "أدخل تاريخًا ميلاديًا صحيحًا للجلسة؛ لم يبدأ تسجيل جلسة جديدة.";
