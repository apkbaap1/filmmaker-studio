import Link from "next/link";
import { Suspense } from "react";
import { SignInForm } from "./sign-in-form";
import { safeCallbackUrl, withCallback } from "@/lib/callback-url";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  // Read here rather than in a client component: a `useSearchParams` link
  // renders as its Suspense fallback in the server's HTML and only becomes a
  // link once JavaScript has run. The one journey this link matters for —
  // somebody following an invitation who has no account yet — deserves better
  // than a word that looks like a link and is not.
  const callbackUrl = safeCallbackUrl((await searchParams).callbackUrl);
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
          <Link href={withCallback("/sign-up", callbackUrl)} className="text-accent hover:underline">
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
