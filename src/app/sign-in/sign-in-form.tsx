"use client";

import { useActionState } from "react";
import { useSearchParams } from "next/navigation";
import { signInAction } from "@/lib/actions/auth";
import { Button, Card, ErrorText, Field, Input } from "@/components/ui";

export function SignInForm() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/dashboard";
  const [state, formAction, pending] = useActionState(signInAction, undefined);

  return (
    <Card className="p-6">
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <Field label="Email">
          <Input type="email" name="email" required autoComplete="email" placeholder="you@production.com" />
        </Field>
        <Field label="Password">
          <Input type="password" name="password" required autoComplete="current-password" placeholder="••••••••" />
        </Field>
        <ErrorText message={state?.error} />
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </Card>
  );
}
