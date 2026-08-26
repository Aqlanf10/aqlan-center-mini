import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/auth/guards";

/** Entry point: send staff to the dashboard or to the login page. */
export default async function Home() {
  const user = await getSessionUser();
  redirect(user ? "/dashboard" : "/login");
}
