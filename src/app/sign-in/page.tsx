import Link from "next/link";
import { Suspense } from "react";
import { SignInForm } from "./sign-in-form";

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Link href="/" className="text-lg font-semibold tracking-tight text-foreground">
            Filmmaker Studio
          </Link>
          <p className="mt-2 text-sm text-muted">Sign in to your productions</p>
        </div>
        <Suspense>
          <SignInForm />
        </Suspense>
        <p className="mt-6 text-center text-sm text-muted">
          No account?{" "}
          <Link href="/sign-up" className="text-accent hover:underline">
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
