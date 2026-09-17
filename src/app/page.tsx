import Link from "next/link";
import { auth } from "@/auth";
import { Button } from "@/components/ui";

export default async function Home() {
  const session = await auth();

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-6">
        <span className="text-lg font-semibold tracking-tight">Filmmaker Studio</span>
        <nav className="flex items-center gap-3">
          {session ? (
            <Link href="/dashboard">
              <Button size="sm">Go to dashboard</Button>
            </Link>
          ) : (
            <>
              <Link href="/sign-in" className="text-sm text-muted hover:text-foreground">
                Sign in
              </Link>
              <Link href="/sign-up">
                <Button size="sm">Get started</Button>
              </Link>
            </>
          )}
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-start justify-center px-6 py-20">
        <p className="mb-3 text-sm font-medium uppercase tracking-widest text-accent">
          Pre-production to wrap
        </p>
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Run your production from one place.
        </h1>
        <p className="mt-5 max-w-xl text-lg text-muted">
          Script breakdown, shot lists, shooting schedules and call sheets, cast &amp; crew,
          locations, equipment, and budget tracking — all in one app built for independent
          filmmakers.
        </p>
        <div className="mt-8 flex gap-3">
          <Link href="/sign-up">
            <Button>Start your production</Button>
          </Link>
          <Link href="/sign-in">
            <Button variant="secondary">Sign in</Button>
          </Link>
        </div>

        <div className="mt-16 grid w-full grid-cols-1 gap-4 sm:grid-cols-3">
          {[
            { title: "Script & Shot Lists", desc: "Break scenes down and plan every shot before you roll." },
            { title: "Schedule & Call Sheets", desc: "Plan shoot days and generate printable call sheets." },
            { title: "Budget & Resources", desc: "Track cast, crew, locations, equipment, and spend." },
          ].map((f) => (
            <div key={f.title} className="rounded-lg border border-border bg-surface p-5">
              <h3 className="text-sm font-semibold text-foreground">{f.title}</h3>
              <p className="mt-2 text-sm text-muted">{f.desc}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
