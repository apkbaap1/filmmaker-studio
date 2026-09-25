import Link from "next/link";
import { Suspense } from "react";
import { SignUpForm } from "./sign-up-form";

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Link href="/" className="text-lg font-semibold tracking-tight text-foreground">
            Filmmaker Studio
          </Link>
          <p className="mt-2 text-sm text-muted">Create your production workspace</p>
        </div>
        <Suspense>
          <SignUpForm />
        </Suspense>
        <p className="mt-6 text-center text-sm text-muted">
          Already have an account?{" "}
          <Link href="/sign-in" className="text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
