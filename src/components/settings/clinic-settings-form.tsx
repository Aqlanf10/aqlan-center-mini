"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField, dictPath } from "@/components/shared/form-field";
import { useI18n } from "@/i18n/provider";
import type { ClinicSettingsValues } from "@/server/settings/queries";
import { updateClinicSettingsAction } from "@/server/settings/actions";

export function ClinicSettingsForm({
  initial,
}: {
  initial: ClinicSettingsValues;
}) {
  const { dict } = useI18n();
  const [values, setValues] = useState(initial);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const set = <K extends keyof ClinicSettingsValues>(
    key: K,
    value: ClinicSettingsValues[K]
  ) => setValues((prev) => ({ ...prev, [key]: value }));

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);
    try {
      const result = await updateClinicSettingsAction({
        displayName: values.displayName,
        defaultRecallIntervalDays: String(values.defaultRecallIntervalDays),
        whatsappTemplateAr: values.whatsappTemplateAr,
        whatsappTemplateEn: values.whatsappTemplateEn,
      });
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
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
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      {formError ? (
        <p
          className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm"
          role="alert"
        >
          {formError}
        </p>
      ) : null}

      <FormField
        id="clinic-displayName"
        label={dict.settingsClinic.displayName}
        error={errorFor("displayName")}
        hint={dict.settingsClinic.displayNameHint}
      >
        <Input
          id="clinic-displayName"
          value={values.displayName}
          onChange={(e) => set("displayName", e.target.value)}
          maxLength={80}
          dir="auto"
        />
      </FormField>

      <FormField
        id="clinic-recall"
        label={dict.settingsClinic.recallInterval}
        error={errorFor("defaultRecallIntervalDays")}
        hint={dict.settingsClinic.recallIntervalHint}
      >
        <Input
          id="clinic-recall"
          type="number"
          min={1}
          max={365}
          value={values.defaultRecallIntervalDays}
          onChange={(e) =>
            set("defaultRecallIntervalDays", Number(e.target.value || 0))
          }
          dir="ltr"
        />
      </FormField>

      <FormField
        id="clinic-wa-ar"
        label={dict.settingsClinic.whatsappAr}
        error={errorFor("whatsappTemplateAr")}
        hint={dict.settingsClinic.templateHint}
      >
        <Textarea
          id="clinic-wa-ar"
          value={values.whatsappTemplateAr}
          onChange={(e) => set("whatsappTemplateAr", e.target.value)}
          rows={3}
          maxLength={500}
          dir="rtl"
        />
      </FormField>

      <FormField
        id="clinic-wa-en"
        label={dict.settingsClinic.whatsappEn}
        error={errorFor("whatsappTemplateEn")}
        hint={dict.settingsClinic.templateHint}
      >
        <Textarea
          id="clinic-wa-en"
          value={values.whatsappTemplateEn}
          onChange={(e) => set("whatsappTemplateEn", e.target.value)}
          rows={3}
          maxLength={500}
          dir="ltr"
        />
      </FormField>

      <div>
        <Button type="submit" disabled={submitting}>
          {dict.settingsClinic.save}
        </Button>
      </div>
    </form>
  );
}
