"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function ProjectTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const base = `/projects/${projectId}`;

  const tabs = [
    { href: base, label: "Overview", exact: true },
    { href: `${base}/scenes`, label: "Script" },
    { href: `${base}/visualization`, label: "Visualization" },
    { href: `${base}/storyboard`, label: "Storyboard" },
    { href: `${base}/timeline`, label: "Timeline" },
    { href: `${base}/continuity`, label: "Continuity" },
    { href: `${base}/schedule`, label: "Schedule" },
    { href: `${base}/cast-crew`, label: "Cast & Crew" },
    { href: `${base}/locations`, label: "Locations" },
    { href: `${base}/equipment`, label: "Equipment" },
    { href: `${base}/budget`, label: "Budget" },
    { href: `${base}/settings`, label: "Settings" },
  ];

  return (
    <div className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((tab) => {
        const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cx(
              "whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
              active
                ? "border-accent text-foreground"
                : "border-transparent text-muted hover:text-foreground"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
