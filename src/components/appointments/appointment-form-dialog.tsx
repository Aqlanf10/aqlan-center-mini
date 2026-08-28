"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, SearchIcon, UserRoundIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField, dictPath } from "@/components/shared/form-field";
import { Select } from "@/components/shared/select";
import { useI18n } from "@/i18n/provider";
import { formatDateTimeLocalInput } from "@/lib/datetime";
import type { PatientOption } from "@/server/patients/queries";
import {
  createAppointmentAction,
  rescheduleAppointmentAction,
} from "@/server/appointments/actions";

export type DoctorOption = { id: string; name: string };

/**
 * Appointment create/reschedule dialog.
 * - Patient is chosen through debounced server-side search (/api/patients/search).
 * - datetime-local values are interpreted in the clinic timezone (Asia/Aden)
 *   and converted to UTC instants server-side.
 */
export function AppointmentFormDialog({
  doctors,
  patient,
  reschedule,
  trigger,
  triggerVariant = "default",
  defaultDate,
}: {
  doctors: DoctorOption[];
  /** Preselected patient (profile page / reschedule). */
  patient?: { id: string; fullName: string; fileNumber: string };
  /** Existing appointment being rescheduled. */
  reschedule?: {
    id: string;
    doctorId: string;
    appointmentDate: Date;
    reason: string | null;
  };
  trigger: string;
  triggerVariant?: "default" | "outline" | "ghost" | "secondary";
  defaultDate?: string;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const [selectedPatient, setSelectedPatient] = useState<PatientOption | null>(
    patient
      ? {
          id: patient.id,
          fullName: patient.fullName,
          fileNumber: patient.fileNumber,
          mobile: "",
          treatmentStatus: "ACTIVE",
        }
      : null
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PatientOption[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [doctorId, setDoctorId] = useState(reschedule?.doctorId ?? "");
  const [appointmentDate, setAppointmentDate] = useState(
    reschedule
      ? formatDateTimeLocalInput(reschedule.appointmentDate)
      : defaultDate ?? ""
  );
  const [reason, setReason] = useState(reschedule?.reason ?? "");
  const [notes, setNotes] = useState("");

  const runSearch = useCallback(async (term: string) => {
    if (term.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const response = await fetch(
        `/api/patients/search?q=${encodeURIComponent(term.trim())}`
      );
      if (!response.ok) {
        setResults([]);
        return;
      }
      const data = (await response.json()) as { options?: PatientOption[] };
      setResults(data.options ?? []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (!open || selectedPatient) {
      return;
    }
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
    }
    searchTimer.current = setTimeout(() => runSearch(query), 300);
    return () => {
      if (searchTimer.current) {
        clearTimeout(searchTimer.current);
      }
    };
  }, [query, open, selectedPatient, runSearch]);

  function reset() {
    setFieldErrors({});
    setFormError(null);
    if (!patient) {
      setSelectedPatient(null);
      setQuery("");
      setResults([]);
    }
    setDoctorId(reschedule?.doctorId ?? "");
    setAppointmentDate(
      reschedule ? formatDateTimeLocalInput(reschedule.appointmentDate) : (defaultDate ?? "")
    );
    setReason(reschedule?.reason ?? "");
    setNotes("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    if (!selectedPatient) {
      setFieldErrors({ patient: "validation.patientRequired" });
      return;
    }
    if (!doctorId) {
      setFieldErrors({ doctorId: "validation.doctorRequired" });
      return;
    }
    if (!appointmentDate) {
      setFieldErrors({ appointmentDate: "validation.datetimeInvalid" });
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        patientId: selectedPatient.id,
        doctorId,
        appointmentDate,
        reason,
        notes,
      };
      const result = reschedule
        ? await rescheduleAppointmentAction(reschedule.id, payload)
        : await createAppointmentAction(payload);

      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        reset();
        router.refresh();
      } else {
        setFieldErrors(result.fieldErrors ?? {});
        setFormError(dictPath(dict, result.errorKey));
      }
    } catch {
      setFormError(dict.common.serverError);
    } finally {
      setSubmitting(false);
    }
  }

  const errorFor = (key: string) =>
    fieldErrors[key] ? dictPath(dict, fieldErrors[key]!) : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant={triggerVariant}>{trigger}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {reschedule
              ? dict.appointments.rescheduleTitle
              : dict.appointments.new}
          </DialogTitle>
          <DialogDescription>{dict.appointments.subtitle}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          {formError ? (
            <p
              className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm"
              role="alert"
            >
              {formError}
            </p>
          ) : null}

          {selectedPatient ? (
            <FormField
              id="appt-patient"
              label={dict.appointments.fields.patientSelected}
              error={errorFor("patient")}
            >
              <div className="border-muted flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                <span className="flex items-center gap-2 text-sm">
                  <UserRoundIcon className="text-muted-foreground size-4" aria-hidden="true" />
                  <span className="font-medium">{selectedPatient.fullName}</span>
                  <span className="text-muted-foreground font-mono text-xs" dir="ltr">
                    {selectedPatient.fileNumber}
                  </span>
                </span>
                {!reschedule ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSelectedPatient(null);
                      setQuery("");
                      setResults([]);
                    }}
                    disabled={submitting}
                  >
                    {dict.appointments.fields.changePatient}
                  </Button>
                ) : null}
              </div>
            </FormField>
          ) : (
            <FormField
              id="appt-patient-search"
              label={dict.appointments.fields.patient}
              required
              error={errorFor("patient")}
            >
              <div className="relative">
                <SearchIcon
                  className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2"
                  aria-hidden="true"
                />
                <Input
                  id="appt-patient-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={dict.appointments.fields.patientSearch}
                  className="ps-8"
                  autoComplete="off"
                  disabled={submitting}
                />
                {searching ? (
                  <LoaderCircleIcon
                    className="text-muted-foreground absolute end-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin"
                    aria-hidden="true"
                  />
                ) : null}
              </div>
              {results.length > 0 ? (
                <ul className="border-muted mt-1 max-h-44 overflow-y-auto rounded-md border">
                  {results.map((option) => (
                    <li key={option.id} className="border-muted border-b last:border-b-0">
                      <button
                        type="button"
                        className="hover:bg-muted/50 flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-sm outline-none focus-visible:bg-muted"
                        onClick={() => {
                          setSelectedPatient(option);
                          setResults([]);
                        }}
                      >
                        <span className="font-medium">{option.fullName}</span>
                        <span className="text-muted-foreground font-mono text-xs" dir="ltr">
                          {option.fileNumber}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : query.trim().length >= 2 && !searching ? (
                <p className="text-muted-foreground text-sm">
                  {dict.appointments.fields.noPatientsFound}
                </p>
              ) : null}
            </FormField>
          )}

          <FormField id="appt-doctor" label={dict.appointments.fields.doctor} required error={errorFor("doctorId")}>
            <Select
              id="appt-doctor"
              value={doctorId}
              onChange={(event) => setDoctorId(event.target.value)}
              disabled={submitting}
              placeholder={dict.appointments.fields.selectDoctor}
              options={doctors.map((doctor) => ({
                value: doctor.id,
                label: doctor.name,
              }))}
            />
          </FormField>

          <FormField id="appt-datetime" label={dict.appointments.fields.dateTime} required error={errorFor("appointmentDate")}>
            <Input
              id="appt-datetime"
              type="datetime-local"
              value={appointmentDate}
              onChange={(event) => setAppointmentDate(event.target.value)}
              disabled={submitting}
              required
            />
          </FormField>

          <FormField id="appt-reason" label={dict.appointments.fields.reason} error={errorFor("reason")}>
            <Input
              id="appt-reason"
              value={reason}
              placeholder={dict.appointments.fields.reasonPlaceholder}
              onChange={(event) => setReason(event.target.value)}
              disabled={submitting}
            />
          </FormField>

          <FormField id="appt-notes" label={dict.appointments.fields.notes} error={errorFor("notes")}>
            <Textarea
              id="appt-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              disabled={submitting}
              rows={2}
            />
          </FormField>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              {dict.common.cancel}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  {dict.common.saving}
                </>
              ) : (
                dict.common.save
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
