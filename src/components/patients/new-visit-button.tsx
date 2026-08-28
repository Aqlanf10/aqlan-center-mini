"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, StethoscopeIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { dictPath } from "@/components/shared/form-field";
import { useI18n } from "@/i18n/provider";
import type { DoctorOption } from "@/components/appointments/appointment-form-dialog";
import { createDraftVisitAction } from "@/server/visits/actions";

/**
 * Start a new standalone visit for a patient (patient profile -> New visit).
 * Creates a DRAFT visit and opens the full visit form.
 */
export function NewVisitButton({
  patientId,
  doctors,
  label,
}: {
  patientId: string;
  doctors: DoctorOption[];
  label: string;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [doctorId, setDoctorId] = useState(doctors[0]?.id ?? "");
  const [pending, setPending] = useState(false);

  async function run() {
    if (!doctorId) {
      return;
    }
    setPending(true);
    try {
      // Empty visitDate = "now", resolved server-side in the clinic timezone.
      const result = await createDraftVisitAction({
        patientId,
        doctorId,
        appointmentId: "",
        visitDate: "",
        chiefComplaint: "",
        treatmentPerformed: "",
        clinicalNotes: "",
        nextVisitPlan: "",
        nextAppointmentDate: "",
      });
      if (!result.ok) {
        toast.error(dictPath(dict, result.errorKey));
        return;
      }
      if (result.id) {
        toast.success(dictPath(dict, result.messageKey));
        setOpen(false);
        router.push(`/visits/${result.id}`);
      }
    } catch {
      toast.error(dict.common.serverError);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button onClick={() => setOpen(true)}>
        <StethoscopeIcon aria-hidden="true" />
        {label}
      </Button>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{dict.visits.newVisit}</DialogTitle>
          <DialogDescription>{dict.visits.fields.doctor}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <select
            value={doctorId}
            onChange={(event) => setDoctorId(event.target.value)}
            aria-label={dict.visits.fields.doctor}
            className="border-input bg-background dark:bg-input/30 h-9 rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {doctors.map((doctor) => (
              <option key={doctor.id} value={doctor.id}>
                {doctor.name}
              </option>
            ))}
          </select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            {dict.common.cancel}
          </Button>
          <Button onClick={run} disabled={pending || !doctorId}>
            {pending ? (
              <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
            ) : (
              <StethoscopeIcon aria-hidden="true" />
            )}
            {dict.visits.newVisit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
