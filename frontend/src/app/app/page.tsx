import { redirect } from "next/navigation";

/**
 * Application entry: resolves to the authenticated landing page.
 * The dashboard is role-aware (merchant + admin), so every signed-in
 * user lands there; later phases may branch this further.
 */
export default function AppIndexPage() {
  redirect("/app/dashboard");
}
