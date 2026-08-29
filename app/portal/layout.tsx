import type { Metadata } from "next";
import { getSettingsSafe } from "@/lib/db";

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSettingsSafe();
  return {
    title: `بوابة المريض — ${settings["clinic.name"]}`,
    description: "كشف حسابك ومواعيدك واستمارتك الصحية، بيتكلم العيادة نفسها.",
  };
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return children;
}
