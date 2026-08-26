"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CheckIcon,
  LogInIcon,
  StethoscopeIcon,
  UserRoundXIcon,
  XCircleIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { dictPath } from "@/components/shared/form-field";
import { AppointmentFormDialog } from "@/components/appointments/appointment-form-dialog";
import { useI18n } from "@/i18n/provider";
import type { Dictionary } from "@/i18n/dictionaries/ar";
import { setAppointmentStatusAction } from "@/server/appointments/actions";
import { startVisitAction } from "@/server/visits/actions";
import type { DoctorOption } from "@/components/appointments/appointment-form-dialog";

export type QuickActionAppointment = {
  id: string;
  patientId: string;
  patientName: string;
  fileNumber: string;
  status: string;
  doctorId: string;
  appointmentDate: Date;
  reason: string | null;
  hasDraftVisit?: boolean;
};

/**
 * Status-aware quick actions for one appointment row:
 * SCHEDULED -> Confirm, CONFIRMED -> Arrived, ARRIVED -> Start Visit,
 * IN_TREATMENT -> Open Visit, plus No Show / Cancel / Reschedule.
 */
export function AppointmentQuickActions({
  appointment,
  doctors,
  compact = false,
}: {
  appointment: QuickActionAppointment;
  doctors: DoctorOption[];
  compact?: boolean;
}) {
  const { dict } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function runStatus(next: "CONFIRMED" | "ARRIVED" | "NO_SHOW" | "CANCELLED") {
    startTransition(async () => {
      const result = await setAppointmentStatusAction(appointment.id, next);
      if (result.ok) {
        toast.success(dictPath(dict, result.messageKey));
        router.refresh();
      } else {
        toast.error(dictPath(dict, result.errorKey));
      }
    });
  }

  function runStartVisit() {
    startTransition(async () => {
      const result = await startVisitAction(appointment.id);
      if (!result.ok) {
        toast.error(dictPath(dict, result.errorKey));
        return;
      }
      toast.success(dictPath(dict, result.messageKey));
      if (result.id) {
        router.push(`/visits/${result.id}`);
      }
    });
  }

  const size = compact ? "sm" : "default";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {appointment.status === "SCHEDULED" ? (
        <ActionButtons
          size={size}
          pending={pending}
          labels={dict}
          onConfirm={() => runStatus("CONFIRMED")}
        />
      ) : null}

      {appointment.status === "CONFIRMED" ? (
        <Button
          size={size}
          onClick={() => runStatus("ARRIVED")}
          disabled={pending}
        >
          <LogInIcon aria-hidden="true" />
          {dict.appointments.quick.arrived}
        </Button>
      ) : null}

      {appointment.status === "ARRIVED" ? (
        <Button size={size} onClick={runStartVisit} disabled={pending}>
          <StethoscopeIcon aria-hidden="true" />
          {dict.appointments.quick.startVisit}
        </Button>
      ) : null}

      {appointment.status === "IN_TREATMENT" ? (
        <Button
          size={size}
          variant="secondary"
          onClick={() => router.push(`/visits/by-appointment/${appointment.id}`)}
          disabled={pending}
        >
          <StethoscopeIcon aria-hidden="true" />
          {dict.appointments.quick.openVisit}
        </Button>
      ) : null}

      {appointment.status === "SCHEDULED" ||
      appointment.status === "CONFIRMED" ? (
        <Button
          variant="ghost"
          size={size}
          onClick={() => runStatus("NO_SHOW")}
          disabled={pending}
          className="text-destructive hover:text-destructive"
        >
          <UserRoundXIcon aria-hidden="true" />
          {dict.appointments.quick.noShow}
        </Button>
      ) : null}

      {appointment.status !== "COMPLETED" && appointment.status !== "CANCELLED" ? (
        <Button
          variant="ghost"
          size={size}
          onClick={() => runStatus("CANCELLED")}
          disabled={pending}
          className="text-muted-foreground hover:text-destructive"
        >
          <XCircleIcon aria-hidden="true" />
          {dict.appointments.quick.cancelAction}
        </Button>
      ) : null}

      {appointment.status !== "COMPLETED" && appointment.status !== "CANCELLED" ? (
        <AppointmentFormDialog
          doctors={doctors}
          patient={{
            id: appointment.patientId,
            fullName: appointment.patientName,
            fileNumber: appointment.fileNumber,
          }}
          reschedule={{
            id: appointment.id,
            doctorId: appointment.doctorId,
            appointmentDate: appointment.appointmentDate,
            reason: appointment.reason,
          }}
          trigger={compact ? dict.appointments.quick.rescheduleAction : dict.appointments.reschedule}
          triggerVariant="outline"
        />
      ) : null}
    </div>
  );
}

function ActionButtons({
  size,
  pending,
  labels,
  onConfirm,
}: {
  size: "sm" | "default";
  pending: boolean;
  labels: Dictionary;
  onConfirm: () => void;
}) {
  return (
    <Button size={size} onClick={onConfirm} disabled={pending}>
      <CheckIcon aria-hidden="true" />
      {labels.appointments.quick.confirm}
    </Button>
  );
}
