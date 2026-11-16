import { NextResponse } from "next/server";
import { PatientNumberingError } from "./patient-numbering-db";
export function patientNumberingErrorResponse(error: unknown) {
  if (error instanceof PatientNumberingError) return NextResponse.json({message: error.message, code: error.code}, {
    status: {invalid: 400, forbidden: 403, stale: 409, duplicate: 409, missing: 404, busy: 409}[error.code],
  });
  return NextResponse.json({message: "تعذّر إتمام عملية الترقيم. حدّث المعاينة قبل المحاولة مجددًا."}, {status: 500});
}
