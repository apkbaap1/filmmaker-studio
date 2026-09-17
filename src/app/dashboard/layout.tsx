import { ReactNode } from "react";
import { requireSession } from "@/lib/access";
import { AppShell } from "@/components/app-shell";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  return <AppShell userName={session.user.name ?? session.user.email ?? "Account"}>{children}</AppShell>;
}
