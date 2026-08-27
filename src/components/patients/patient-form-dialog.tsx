"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangleIcon, LoaderCircleIcon } from "lucide-react";
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
import {
  FormField,
  dictPath,
} from "@/components/shared/form-field";
import { Select } from "@/components/shared/select";
import { useI18n } from "@/i18n/provider";
import type { TreatmentStatus } from "@/db/schema/enums";
import type { SimilarPatient } from "@/server/patients/duplicates";
import {
  createPatientAction,
  findSimilarPatientsAction,
  updatePatientAction,
} from "@/server/patients/actions";

export type DoctorOption = { id: string; name: string };

export type PatientFormValues = {
  fullName: string;
  gender: "MALE" | "FEMALE";
  dateOfBirth: string;
  mobile: string;
  alternateMobile: string;
  address: string;
  treatingDoctorId: string;
  treatmentType: string;
  treatmentStatus: TreatmentStatus;
  recallIntervalDays: number;
  notes: string;
};

const RECALL_PRESETS = [7, 14, 21, 30];

export function PatientFormDialog({
  doctors,
  patient,
  trigger,
  triggerVariant = "default",
}: {
  doctors: DoctorOption[];
  patient?: { id: string; values: PatientFormValues };
  trigger: string;
  triggerVariant?: "default" | "outline";
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<SimilarPatient[] | null>(null);
  const [checking, setChecking] = useState(false);

  const initial: PatientFormValues = patient?.values ?? {
    fullName: "",
    gender: "MALE",
    dateOfBirth: "",
    mobile: "",
    alternateMobile: "",
    address: "",
    treatingDoctorId: "",
    treatmentType: "",
    treatmentStatus: "NEW",
    recallIntervalDays: 21,
    notes: "",
  };

  const [values, setValues] = useState<PatientFormValues>(initial);
  const [customRecall, setCustomRecall] = useState(
    patient ? !RECALL_PRESETS.includes(patient.values.recallIntervalDays) : false
  );

  function reset() {
    setValues(initial);
    setFieldErrors({});
    setFormError(null);
    setDuplicates(null);
    setCustomRecall(
      patient
        ? !RECALL_PRESETS.includes(patient.values.recallIntervalDays)
        : false
    );
  }

  function set<K extends keyof PatientFormValues>(
    key: K,
    value: PatientFormValues[K]
  ) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      if (!prev[key as string]) return prev;
      const next = { ...prev };
      delete next[key as string];
      return next;
    });
    // Re-run the duplicate check when identity fields change.
    if (key === "fullName" || key === "mobile" || key === "alternateMobile") {
      setDuplicates(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const payload: Record<string, string> = {
      fullName: values.fullName,
      gender: values.gender,
      dateOfBirth: values.dateOfBirth,
      mobile: values.mobile,
      alternateMobile: values.alternateMobile,
      address: values.address,
      treatingDoctorId: values.treatingDoctorId,
      treatmentType: values.treatmentType,
      treatmentStatus: values.treatmentStatus,
      recallIntervalDays: String(values.recallIntervalDays),
      notes: values.notes,
    };

    // New patients only: warn once about possible existing records
    // (same mobile line, or same name + similar line). Saving stays
    // possible — family members may share a number.
    if (!patient && duplicates === null) {
      setChecking(true);
      try {
        const check = await findSimilarPatientsAction({
          fullName: values.fullName,
          mobile: values.mobile,
        });
        if (check.ok && check.duplicates.length > 0) {
          setDuplicates(check.duplicates);
          return;
        }
        setDuplicates([]); // mark checked, no matches
      } catch {
        setDuplicates([]); // never block saving on a failed check
      } finally {
        setChecking(false);
      }
    }

    setSubmitting(true);
    try {
      const result = patient
        ? await updatePatientAction(patient.id, payload)
        : await createPatientAction(payload);

      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        reset();
        router.refresh();
      } else {
        setFieldErrors(result.fieldErrors ?? {});
        if (Object.keys(result.fieldErrors ?? {}).length === 0) {
          setFormError(dictPath(dict, result.errorKey));
        }
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
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) reset(); }}>
      <DialogTrigger asChild>
        <Button variant={triggerVariant}>{trigger}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {patient ? dict.patients.editPatient : dict.patients.addPatient}
          </DialogTitle>
          <DialogDescription>
            {patient
              ? dict.patients.fields.fileNumber
              : dict.patients.fields.autoFileNumber}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          {formError ? (
            <p className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm" role="alert">
              {formError}
            </p>
          ) : null}

          {!patient && duplicates !== null && duplicates.length > 0 ? (
            <div
              className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200 flex flex-col gap-2 rounded-md border p-3 text-sm"
              role="alert"
            >
              <p className="flex items-center gap-2 font-medium">
                <AlertTriangleIcon className="size-4 shrink-0" aria-hidden="true" />
                {dict.patients.duplicate.title}
              </p>
              <ul className="flex flex-col gap-1.5">
                {duplicates.map((dup) => (
                  <li key={dup.id} className="flex flex-wrap items-center gap-x-2">
                    <a
                      href={`/patients/${dup.id}`}
                      className="font-medium underline underline-offset-2"
                      target="_blank"
                      rel="noopener noreferrer"
                      dir="auto"
                    >
                      {dup.fullName}
                    </a>
                    <span className="text-xs opacity-80">
                      {dup.fileNumber}
                      {dup.mobile ? ` · ${dup.mobile}` : ""} ·{" "}
                      {dict.patients.duplicate.reasons[dup.reason]}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-xs opacity-80">{dict.patients.duplicate.hint}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setOpen(false)}
                  disabled={submitting}
                >
                  {dict.patients.duplicate.review}
                </Button>
                <Button type="submit" size="sm" disabled={submitting}>
                  {dict.patients.duplicate.saveAnyway}
                </Button>
              </div>
            </div>
          ) : null}

          <FormField
            id="patient-fullName"
            label={dict.patients.fields.fullName}
            required
            error={errorFor("fullName")}
          >
            <Input
              id="patient-fullName"
              value={values.fullName}
              onChange={(e) => set("fullName", e.target.value)}
              disabled={submitting}
              required
              autoComplete="off"
            />
          </FormField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField id="patient-gender" label={dict.patients.fields.gender} required error={errorFor("gender")}>
              <Select
                id="patient-gender"
                value={values.gender}
                onChange={(e) => set("gender", e.target.value as "MALE" | "FEMALE")}
                disabled={submitting}
                options={[
                  { value: "MALE", label: dict.statuses.gender.MALE },
                  { value: "FEMALE", label: dict.statuses.gender.FEMALE },
                ]}
              />
            </FormField>

            <FormField id="patient-dob" label={dict.patients.fields.dateOfBirth} error={errorFor("dateOfBirth")}>
              <Input
                id="patient-dob"
                type="date"
                value={values.dateOfBirth}
                onChange={(e) => set("dateOfBirth", e.target.value)}
                disabled={submitting}
              />
            </FormField>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField id="patient-mobile" label={dict.patients.fields.mobile} required error={errorFor("mobile")} hint="+967…">
              <Input
                id="patient-mobile"
                type="tel"
                dir="ltr"
                inputMode="tel"
                value={values.mobile}
                onChange={(e) => set("mobile", e.target.value)}
                disabled={submitting}
                required
              />
            </FormField>

            <FormField id="patient-altmobile" label={dict.patients.fields.alternateMobile} error={errorFor("alternateMobile")}>
              <Input
                id="patient-altmobile"
                type="tel"
                dir="ltr"
                inputMode="tel"
                value={values.alternateMobile}
                onChange={(e) => set("alternateMobile", e.target.value)}
                disabled={submitting}
              />
            </FormField>
          </div>

          <FormField id="patient-address" label={dict.patients.fields.address} error={errorFor("address")}>
            <Input
              id="patient-address"
              value={values.address}
              onChange={(e) => set("address", e.target.value)}
              disabled={submitting}
            />
          </FormField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField id="patient-doctor" label={dict.patients.fields.treatingDoctor} error={errorFor("treatingDoctorId")}>
              <Select
                id="patient-doctor"
                value={values.treatingDoctorId}
                onChange={(e) => set("treatingDoctorId", e.target.value)}
                disabled={submitting}
                options={[
                  { value: "", label: dict.patients.fields.noDoctor },
                  ...doctors.map((d) => ({ value: d.id, label: d.name })),
                ]}
              />
            </FormField>

            <FormField id="patient-treatmenttype" label={dict.patients.fields.treatmentType} error={errorFor("treatmentType")}>
              <Input
                id="patient-treatmenttype"
                value={values.treatmentType}
                placeholder={dict.patients.fields.treatmentTypePlaceholder}
                onChange={(e) => set("treatmentType", e.target.value)}
                disabled={submitting}
              />
            </FormField>
          </div>

          <FormField id="patient-status" label={dict.patients.fields.treatmentStatus} required error={errorFor("treatmentStatus")}>
            <Select
              id="patient-status"
              value={values.treatmentStatus}
              onChange={(e) => set("treatmentStatus", e.target.value as TreatmentStatus)}
              disabled={submitting}
              options={(["NEW", "ACTIVE", "RETENTION", "COMPLETED", "PAUSED"] as const).map(
                (value) => ({
                  value,
                  label: dict.statuses.treatment[value],
                })
              )}
            />
          </FormField>

          <FormField
            id="patient-recall"
            label={dict.patients.fields.recallIntervalDays}
            hint={`${dict.patients.fields.recallPresets}: ${RECALL_PRESETS.join(" / ")} ${dict.patients.fields.days}`}
            error={errorFor("recallIntervalDays")}
          >
            <div className="flex flex-wrap items-center gap-2">
              {RECALL_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  size="sm"
                  variant={
                    !customRecall && values.recallIntervalDays === preset
                      ? "default"
                      : "outline"
                  }
                  onClick={() => {
                    setCustomRecall(false);
                    set("recallIntervalDays", preset);
                  }}
                  disabled={submitting}
                  aria-pressed={!customRecall && values.recallIntervalDays === preset}
                >
                  {preset}
                </Button>
              ))}
              <Button
                type="button"
                size="sm"
                variant={customRecall ? "default" : "outline"}
                onClick={() => setCustomRecall(true)}
                disabled={submitting}
                aria-pressed={customRecall}
              >
                {dict.common.edit}
              </Button>
              {customRecall ? (
                <Input
                  id="patient-recall"
                  type="number"
                  min={1}
                  max={365}
                  className="w-24"
                  value={values.recallIntervalDays}
                  onChange={(e) =>
                    set("recallIntervalDays", Number(e.target.value) || 0)
                  }
                  disabled={submitting}
                />
              ) : null}
            </div>
          </FormField>

          <FormField id="patient-notes" label={dict.patients.fields.notes} error={errorFor("notes")}>
            <Textarea
              id="patient-notes"
              value={values.notes}
              placeholder={dict.patients.fields.notesPlaceholder}
              onChange={(e) => set("notes", e.target.value)}
              disabled={submitting}
              rows={3}
            />
          </FormField>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              {dict.common.cancel}
            </Button>
            <Button type="submit" disabled={submitting || checking}>
              {submitting || checking ? (
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
