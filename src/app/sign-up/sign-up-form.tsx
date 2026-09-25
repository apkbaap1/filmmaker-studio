"use client";

import { useActionState } from "react";
import { useSearchParams } from "next/navigation";
import { signUpAction } from "@/lib/actions/auth";
import { Button, Card, ErrorText, Field, Input } from "@/components/ui";

export function SignUpForm() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/dashboard";
  const [state, formAction, pending] = useActionState(signUpAction, undefined);

  return (
    <Card className="p-6">
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <Field label="Name">
          <Input type="text" name="name" required autoComplete="name" placeholder="Jordan Rivera" />
        </Field>
        <Field label="Email">
          <Input type="email" name="email" required autoComplete="email" placeholder="you@production.com" />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            name="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="At least 8 characters"
          />
        </Field>
        <ErrorText message={state?.error} />
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </Card>
  );
}
