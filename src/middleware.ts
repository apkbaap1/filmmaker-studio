import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";

const { auth } = NextAuth(authConfig);

const PUBLIC_PATHS = ["/", "/sign-in", "/sign-up"];

/**
 * Paths reachable without a session.
 *
 * `/invitations/*` is public and its page does its own gating. Redirecting a
 * signed-out visitor straight to sign-in looks equivalent and is not: somebody
 * who has been invited may have no account yet, and the sign-in page's "Create
 * one" link does not carry the callback, so they would arrive at sign-up having
 * lost the invitation. The page shows both routes with the token preserved, and
 * reveals nothing about the project until the reader is signed in as the
 * address it names.
 *
 * `/api/health` is public because a load balancer has no session and must not
 * need one to ask whether the process is alive.
 */
const PUBLIC_PREFIXES = ["/api/auth", "/api/register", "/api/health", "/invitations/"];

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isPublic =
    PUBLIC_PATHS.includes(pathname) ||
    PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  if (!req.auth && !isPublic) {
    const signInUrl = new URL("/sign-in", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(signInUrl);
  }
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
