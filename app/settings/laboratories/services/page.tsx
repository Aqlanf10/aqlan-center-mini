import { redirect } from "next/navigation";

export default function LegacyLaboratoriesServicesRedirectPage() {
  redirect("/settings/lab-services");
}
