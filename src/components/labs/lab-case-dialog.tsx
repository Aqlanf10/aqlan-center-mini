"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, PlusIcon } from "lucide-react";
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
import type { Currency } from "@/db/schema/enums";
import { createLabCaseAction } from "@/server/labs/actions";

const CURRENCIES: Currency[] = ["YER", "SAR", "USD"];
const STATUSES = ["ORDERED", "SENT", "RECEIVED", "DELIVERED", "CANCELLED"] as const;

export type LabCaseOptionSource = {
  labs: { id: string; label: string }[];
  patients: { id: string; label: string }[];
  doctors: { id: string; label: string }[];
  services: { id: string; label: string }[];
};

/** Create a lab case linked to patient/visit/doctor/service. */
export function LabCaseDialog({ source }: { source: LabCaseOptionSource }) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const [labId, setLabId] = useState("");
  const [patientId, setPatientId] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [workType, setWorkType] = useState("");
  const [cost, setCost] = useState("");
  const [currency, setCurrency] = useState<Currency>("YER");
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("ORDERED");
  const [expectedDeliveryAt, setExpectedDeliveryAt] = useState("");
  const [notes, setNotes] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = await createLabCaseAction({
        labId,
        patientId,
        doctorId,
        serviceId,
        workType,
        cost,
        currency,
        status,
        expectedDeliveryAt,
        notes,
      });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        setWorkType("");
        setCost("");
        setNotes("");
        setFieldErrors({});
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon aria-hidden="true" />
          {dict.labs.newCase}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{dict.labs.newCase}</DialogTitle>
          <DialogDescription>{dict.labs.subtitle}</DialogDescription>
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

          <FormField id="case-lab" label={dict.labs.caseFields.lab} required error={errorFor("labId")}>
            <Select
              id="case-lab"
              value={labId}
              onChange={(event) => setLabId(event.target.value)}
              disabled={submitting}
            >
              <option value="">{dict.common.select}</option>
              {source.labs.map((lab) => (
                <option key={lab.id} value={lab.id}>
                  {lab.label}
                </option>
              ))}
            </Select>
          </FormField>

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              id="case-patient"
              label={dict.labs.caseFields.patient}
              required
              error={errorFor("patientId")}
            >
              <Select
                id="case-patient"
                value={patientId}
                onChange={(event) => setPatientId(event.target.value)}
                disabled={submitting}
              >
                <option value="">{dict.common.select}</option>
                {source.patients.map((patient) => (
                  <option key={patient.id} value={patient.id}>
                    {patient.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              id="case-doctor"
              label={dict.labs.caseFields.doctor}
              required
              error={errorFor("doctorId")}
            >
              <Select
                id="case-doctor"
                value={doctorId}
                onChange={(event) => setDoctorId(event.target.value)}
                disabled={submitting}
              >
                <option value="">{dict.common.select}</option>
                {source.doctors.map((doctor) => (
                  <option key={doctor.id} value={doctor.id}>
                    {doctor.label}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>

          <FormField id="case-service" label={dict.labs.caseFields.service}>
            <Select
              id="case-service"
              value={serviceId}
              onChange={(event) => setServiceId(event.target.value)}
              disabled={submitting}
            >
              <option value="">{dict.common.select}</option>
              {source.services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField
            id="case-work-type"
            label={dict.labs.caseFields.workType}
            required
            error={errorFor("workType")}
          >
            <Input
              id="case-work-type"
              value={workType}
              onChange={(event) => setWorkType(event.target.value)}
              disabled={submitting}
              required
            />
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField
              id="case-cost"
              label={dict.labs.caseFields.cost}
              required
              error={errorFor("cost")}
            >
              <Input
                id="case-cost"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0.01"
                dir="ltr"
                value={cost}
                onChange={(event) => setCost(event.target.value)}
                disabled={submitting}
                required
              />
            </FormField>
            <FormField
              id="case-currency"
              label={dict.labs.caseFields.currency}
              required
              error={errorFor("currency")}
            >
              <Select
                id="case-currency"
                value={currency}
                onChange={(event) => setCurrency(event.target.value as Currency)}
                disabled={submitting}
              >
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField id="case-status" label={dict.labs.caseFields.status} required>
              <Select
                id="case-status"
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as (typeof STATUSES)[number])
                }
                disabled={submitting}
              >
                {STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {dict.labs.statuses[value]}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              id="case-expected"
              label={dict.labs.caseFields.expectedDeliveryAt}
              error={errorFor("expectedDeliveryAt")}
            >
              <Input
                id="case-expected"
                type="date"
                value={expectedDeliveryAt}
                onChange={(event) => setExpectedDeliveryAt(event.target.value)}
                disabled={submitting}
              />
            </FormField>
          </div>

          <FormField id="case-notes" label={dict.labs.fields.notes}>
            <Textarea
              id="case-notes"
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
              {submitting ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
              {dict.common.save}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
