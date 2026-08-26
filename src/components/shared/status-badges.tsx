import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Dictionary } from "@/i18n/dictionaries/ar";

/**
 * Domain status badge: maps a domain status to its translated label and a
 * semantic color family. One component for appointment/visit/treatment/
 * follow-up/contact statuses so colors stay consistent app-wide.
 */

type Tone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "muted";

const toneClasses: Record<Tone, string> = {
  neutral: "border-transparent bg-primary/10 text-primary",
  info: "border-transparent bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  success:
    "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  warning:
    "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  danger:
    "border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  muted: "border-transparent bg-muted text-muted-foreground",
};

const APPOINTMENT_TONES: Record<string, Tone> = {
  SCHEDULED: "info",
  CONFIRMED: "neutral",
  ARRIVED: "warning",
  IN_TREATMENT: "warning",
  COMPLETED: "success",
  CANCELLED: "muted",
  NO_SHOW: "danger",
};

const TREATMENT_TONES: Record<string, Tone> = {
  NEW: "info",
  ACTIVE: "neutral",
  RETENTION: "info",
  COMPLETED: "success",
  PAUSED: "warning",
};

const FOLLOW_UP_TONES: Record<string, Tone> = {
  ON_TIME: "success",
  DUE_SOON: "warning",
  DUE_TODAY: "warning",
  OVERDUE: "danger",
  NO_NEXT_APPOINTMENT: "info",
  MISSED: "danger",
  INACTIVE: "muted",
};

const CONTACT_RESULT_TONES: Record<string, Tone> = {
  CONTACTED: "success",
  NO_ANSWER: "danger",
  RESCHEDULED: "info",
  WILL_CALL_BACK: "warning",
  CANCELLED: "muted",
  OTHER: "neutral",
};

export function AppointmentStatusBadge({
  status,
  dict,
}: {
  status: string;
  dict: Dictionary;
}) {
  return (
    <StatusBadge
      label={dict.statuses.appointment[status as keyof typeof dict.statuses.appointment] ?? status}
      tone={APPOINTMENT_TONES[status] ?? "neutral"}
    />
  );
}

export function TreatmentStatusBadge({
  status,
  dict,
}: {
  status: string;
  dict: Dictionary;
}) {
  return (
    <StatusBadge
      label={dict.statuses.treatment[status as keyof typeof dict.statuses.treatment] ?? status}
      tone={TREATMENT_TONES[status] ?? "neutral"}
    />
  );
}

export function VisitStatusBadge({
  status,
  dict,
}: {
  status: string;
  dict: Dictionary;
}) {
  const tone: Tone = status === "COMPLETED" ? "success" : "warning";
  return (
    <StatusBadge
      label={dict.statuses.visit[status as keyof typeof dict.statuses.visit] ?? status}
      tone={tone}
    />
  );
}

export function FollowUpStatusBadge({
  status,
  dict,
}: {
  status: string;
  dict: Dictionary;
}) {
  return (
    <StatusBadge
      label={dict.statuses.followUp[status as keyof typeof dict.statuses.followUp] ?? status}
      tone={FOLLOW_UP_TONES[status] ?? "neutral"}
    />
  );
}

export function ContactResultBadge({
  result,
  dict,
}: {
  result: string;
  dict: Dictionary;
}) {
  return (
    <StatusBadge
      label={dict.statuses.contactResult[result as keyof typeof dict.statuses.contactResult] ?? result}
      tone={CONTACT_RESULT_TONES[result] ?? "neutral"}
    />
  );
}

export function ActiveBadge({ active, dict }: { active: boolean; dict: Dictionary }) {
  return (
    <StatusBadge
      label={active ? dict.common.active : dict.common.inactive}
      tone={active ? "success" : "muted"}
    />
  );
}

export function RoleBadge({ role, dict }: { role: string; dict: Dictionary }) {
  return (
    <StatusBadge
      label={dict.roles[role as keyof typeof dict.roles] ?? role}
      tone={role === "ADMIN" ? "danger" : role === "DOCTOR" ? "info" : "neutral"}
    />
  );
}

function StatusBadge({ label, tone }: { label: string; tone: Tone }) {
  return <Badge className={cn(toneClasses[tone])}>{label}</Badge>;
}
