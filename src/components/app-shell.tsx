import Link from "next/link";
import { ReactNode } from "react";
import { signOutAction } from "@/lib/actions/misc";
import { Button } from "@/components/ui";

export function AppShell({
  userName,
  children,
}: {
  userName: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border print:hidden">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/dashboard" className="text-base font-semibold tracking-tight text-foreground">
            Filmmaker Studio
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted">{userName}</span>
            <form action={signOutAction}>
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
    </div>
  );
}
