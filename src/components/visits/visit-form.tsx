"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CheckCircleIcon, LoaderCircleIcon, SaveIcon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  FormField,
  dictPath,
} from "@/components/shared/form-field";
import { Select } from "@/components/shared/select";
import { useI18n } from "@/i18n/provider";
import { saveVisitAction } from "@/server/visits/actions";

export type VisitFormProps = {
  visitId: string;
  doctors: { id: string; name: string }[];
  patientName: string;
  patientId: string;
  initialValues: {
    doctorId: string;
    visitDate: string; // datetime-local
    chiefComplaint: string;
    treatmentPerformed: string;
    clinicalNotes: string;
    nextVisitPlan: string;
  };
  isDraft: boolean;
};

/**
 * Full-page visit form. "Complete visit" atomically saves the visit,
 * completes the linked appointment and optionally books the next
 * appointment; "Save as draft" keeps it editable.
 */
export function VisitForm({
  visitId,
  doctors,
  patientId,
  initialValues,
  isDraft,
}: VisitFormProps) {
  const { dict } = useI18n();
  const router = useRouter();
  const [values, setValues] = useState(initialValues);
  const [nextAppointmentDate, setNextAppointmentDate] = useState("");
  const [submitting, setSubmitting] = useState<"draft" | "complete" | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  function set(key: keyof typeof values, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      if (!prev[key as string]) return prev;
      const next = { ...prev };
      delete next[key as string];
      return next;
    });
  }

  async function handleSubmit(complete: boolean) {
    setFormError(null);

    if (!values.doctorId) {
      setFieldErrors({ doctorId: "validation.doctorRequired" });
      return;
    }

    setSubmitting(complete ? "complete" : "draft");
    try {
      const result = await saveVisitAction(
        visitId,
        {
          patientId,
          doctorId: values.doctorId,
          appointmentId: "",
          visitDate: values.visitDate,
          chiefComplaint: values.chiefComplaint,
          treatmentPerformed: values.treatmentPerformed,
          clinicalNotes: values.clinicalNotes,
          nextVisitPlan: values.nextVisitPlan,
          nextAppointmentDate,
        },
        complete
      );

      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        router.push(`/patients/${patientId}?tab=visits`);
        router.refresh();
      } else {
        setFieldErrors(result.fieldErrors ?? {});
        setFormError(dictPath(dict, result.errorKey));
      }
    } catch {
      setFormError(dict.common.serverError);
    } finally {
      setSubmitting(null);
    }
  }

  const errorFor = (key: string) =>
    fieldErrors[key] ? dictPath(dict, fieldErrors[key]!) : undefined;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        handleSubmit(true);
      }}
      noValidate
    >
      {formError ? (
        <p
          className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm"
          role="alert"
        >
          {formError}
        </p>
      ) : null}

      {isDraft ? (
        <Alert>
          <AlertTitle>{dict.visits.draftBadge}</AlertTitle>
          <AlertDescription>{dict.visits.draftNotice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField id="visit-doctor" label={dict.visits.fields.doctor} required error={errorFor("doctorId")}>
          <Select
            id="visit-doctor"
            value={values.doctorId}
            onChange={(event) => set("doctorId", event.target.value)}
            disabled={submitting !== null}
            options={doctors.map((doctor) => ({
              value: doctor.id,
              label: doctor.name,
            }))}
          />
        </FormField>

        <FormField id="visit-date" label={dict.visits.fields.visitDate} required error={errorFor("visitDate")}>
          <Input
            id="visit-date"
            type="datetime-local"
            value={values.visitDate}
            onChange={(event) => set("visitDate", event.target.value)}
            disabled={submitting !== null}
            required
          />
        </FormField>
      </div>

      <FormField id="visit-complaint" label={dict.visits.fields.chiefComplaint} error={errorFor("chiefComplaint")}>
        <Input
          id="visit-complaint"
          value={values.chiefComplaint}
          placeholder={dict.visits.fields.chiefComplaintPlaceholder}
          onChange={(event) => set("chiefComplaint", event.target.value)}
          disabled={submitting !== null}
        />
      </FormField>

      <FormField
        id="visit-treatment"
        label={dict.visits.fields.treatmentPerformed}
        required
        error={errorFor("treatmentPerformed")}
      >
        <Textarea
          id="visit-treatment"
          value={values.treatmentPerformed}
          placeholder={dict.visits.fields.treatmentPerformedPlaceholder}
          onChange={(event) => set("treatmentPerformed", event.target.value)}
          disabled={submitting !== null}
          rows={3}
        />
      </FormField>

      <FormField id="visit-notes" label={dict.visits.fields.clinicalNotes} error={errorFor("clinicalNotes")}>
        <Textarea
          id="visit-notes"
          value={values.clinicalNotes}
          onChange={(event) => set("clinicalNotes", event.target.value)}
          disabled={submitting !== null}
          rows={4}
        />
      </FormField>

      <FormField id="visit-nextplan" label={dict.visits.fields.nextVisitPlan} error={errorFor("nextVisitPlan")}>
        <Textarea
          id="visit-nextplan"
          value={values.nextVisitPlan}
          placeholder={dict.visits.fields.nextVisitPlanPlaceholder}
          onChange={(event) => set("nextVisitPlan", event.target.value)}
          disabled={submitting !== null}
          rows={2}
        />
      </FormField>

      <div className="border-muted rounded-lg border p-3">
        <FormField
          id="visit-nextappt"
          label={dict.visits.fields.nextAppointment}
          hint={dict.visits.fields.createNextAppointment}
          error={errorFor("nextAppointmentDate")}
        >
          <Input
            id="visit-nextappt"
            type="datetime-local"
            value={nextAppointmentDate}
            onChange={(event) => setNextAppointmentDate(event.target.value)}
            disabled={submitting !== null}
          />
        </FormField>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => handleSubmit(false)}
          disabled={submitting !== null}
        >
          {submitting === "draft" ? (
            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
          ) : (
            <SaveIcon aria-hidden="true" />
          )}
          {dict.visits.saveDraft}
        </Button>
        <Button type="submit" disabled={submitting !== null}>
          {submitting === "complete" ? (
            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
          ) : (
            <CheckCircleIcon aria-hidden="true" />
          )}
          {dict.visits.completeVisit}
        </Button>
      </div>
    </form>
  );
}
