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
import { FormField, dictPath } from "@/components/shared/form-field";
import { Select } from "@/components/shared/select";
import { useI18n } from "@/i18n/provider";
import { saveCommissionPlanAction, deleteCommissionPlanAction } from "@/server/commissions/actions";

export type PlanDoctorOption = { id: string; label: string };
export type PlanServiceOption = { id: string; label: string };

/** Create or update a commission plan (doctor default or per-service). */
export function CommissionPlanDialog({
  doctors,
  services,
  plan,
}: {
  doctors: PlanDoctorOption[];
  services: PlanServiceOption[];
  plan?: {
    id: string;
    doctorId: string;
    serviceId: string | null;
    basis: "WORK_VALUE" | "COLLECTED";
    type: "PERCENT" | "FIXED";
    value: string;
  };
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [doctorId, setDoctorId] = useState(plan?.doctorId ?? "");
  const [serviceId, setServiceId] = useState(plan?.serviceId ?? "");
  const [basis, setBasis] = useState<"WORK_VALUE" | "COLLECTED">(
    plan?.basis ?? "WORK_VALUE"
  );
  const [type, setType] = useState<"PERCENT" | "FIXED">(plan?.type ?? "PERCENT");
  const [value, setValue] = useState(plan?.value ?? "");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = await saveCommissionPlanAction({
        doctorId,
        serviceId,
        basis,
        type,
        value,
      });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        setValue("");
        router.refresh();
      } else {
        const errors = result.fieldErrors ?? {};
        if (Object.keys(errors).length > 0) {
          setFormError(dictPath(dict, Object.values(errors)[0]!));
        } else {
          setFormError(dictPath(dict, result.errorKey));
        }
      }
    } catch {
      setFormError(dict.common.serverError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={plan ? "outline" : "default"} size={plan ? "sm" : "default"}>
          {plan ? null : <PlusIcon aria-hidden="true" />}
          {plan ? dict.common.edit : dict.commissions.newPlan}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{dict.commissions.newPlan}</DialogTitle>
          <DialogDescription>{dict.commissions.subtitle}</DialogDescription>
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

          <FormField id="plan-doctor" label={dict.commissions.fields.doctor} required>
            <Select
              id="plan-doctor"
              value={doctorId}
              onChange={(event) => setDoctorId(event.target.value)}
              disabled={submitting || Boolean(plan)}
            >
              <option value="">{dict.common.select}</option>
              {doctors.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField id="plan-service" label={dict.commissions.fields.service}>
            <Select
              id="plan-service"
              value={serviceId}
              onChange={(event) => setServiceId(event.target.value)}
              disabled={submitting || Boolean(plan)}
            >
              <option value="">{dict.common.select}</option>
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.label}
                </option>
              ))}
            </Select>
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField id="plan-basis" label={dict.commissions.fields.basis} required>
              <Select
                id="plan-basis"
                value={basis}
                onChange={(event) => setBasis(event.target.value as "WORK_VALUE" | "COLLECTED")}
                disabled={submitting}
              >
                <option value="WORK_VALUE">{dict.commissions.basis.WORK_VALUE}</option>
                <option value="COLLECTED">{dict.commissions.basis.COLLECTED}</option>
              </Select>
            </FormField>
            <FormField id="plan-type" label={dict.commissions.fields.type} required>
              <Select
                id="plan-type"
                value={type}
                onChange={(event) => setType(event.target.value as "PERCENT" | "FIXED")}
                disabled={submitting}
              >
                <option value="PERCENT">{dict.commissions.types.PERCENT}</option>
                <option value="FIXED">{dict.commissions.types.FIXED}</option>
              </Select>
            </FormField>
          </div>

          <FormField id="plan-value" label={dict.commissions.fields.value} required>
            <Input
              id="plan-value"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              dir="ltr"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={submitting}
              required
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

/** Delete a plan (existing commissions keep their snapshots). */
export function CommissionPlanDeleteButton({ planId }: { planId: string }) {
  const { dict } = useI18n();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleDelete() {
    setPending(true);
    try {
      const result = await deleteCommissionPlanAction(planId);
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        router.refresh();
      } else {
        toast.error(dictPath(dict, result.errorKey));
      }
    } catch {
      toast.error(dict.common.serverError);
    } finally {
      setPending(false);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={handleDelete} disabled={pending}>
      {dict.commissions.deletePlan}
    </Button>
  );
}
