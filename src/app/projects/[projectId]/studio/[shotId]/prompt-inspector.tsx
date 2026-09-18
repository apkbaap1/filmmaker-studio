"use client";

import { useState } from "react";
import { Badge, Button, Card } from "@/components/ui";

/**
 * The technical inspector — Layer 2 laid open.
 *
 * Provenance is not reconstructed here: the compiler already tags every value it
 * carries with the field it came from (`{ value, from }`), so this walks the
 * specification and prints what is actually recorded. A value with no recorded
 * provenance shows none rather than a guess, and a field the filmmaker left
 * blank is absent from the spec entirely — which is itself the answer to "why
 * isn't this in my prompt?".
 */

type Specified = { value: unknown; from: string };

function isSpecified(value: unknown): value is Specified {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    "from" in value &&
    typeof (value as Specified).from === "string"
  );
}

const MODE_LABEL = {
  IMAGE: "Image",
  VIDEO: "Video",
  IMAGE_TO_VIDEO: "Image → Video",
} as const;

type Mode = keyof typeof MODE_LABEL;

interface Entry {
  path: string;
  value: string;
  from?: string;
}

/** Walks the spec, collecting stated values and the field each came from. */
function collect(node: unknown, prefix: string, out: Entry[]) {
  if (node === null || node === undefined) return;

  if (isSpecified(node)) {
    out.push({ path: prefix, value: String(node.value), from: node.from });
    return;
  }

  if (Array.isArray(node)) {
    if (node.length === 0) return;
    if (node.every((item) => typeof item === "string")) {
      out.push({ path: prefix, value: node.join(", ") });
      return;
    }
    node.forEach((item, index) => collect(item, `${prefix}[${index}]`, out));
    return;
  }

  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      collect(value, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }

  if (typeof node === "string" && node === "") return;
  out.push({ path: prefix, value: String(node) });
}

export function PromptInspector({
  specs,
  blocking,
}: {
  specs: Record<Mode, unknown>;
  blocking: unknown;
}) {
  const [mode, setMode] = useState<Mode>("IMAGE");
  const [showRaw, setShowRaw] = useState(false);

  const entries: Entry[] = [];
  collect(specs[mode], "", entries);

  const withProvenance = entries.filter((e) => e.from);
  const derived = entries.filter((e) => !e.from);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Specification inspector</h3>
          {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
            <Button
              key={m}
              size="sm"
              variant={m === mode ? "primary" : "ghost"}
              onClick={() => setMode(m)}
            >
              {MODE_LABEL[m]}
            </Button>
          ))}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? "Hide raw spec" : "Show raw spec"}
          </Button>
        </div>
        <p className="text-xs text-muted">
          Layer 2 — the provider-independent specification. Every value below is one the filmmaker
          stated; a field left blank is not here at all, which is why it does not appear in the
          prompt.
        </p>
      </Card>

      <Card className="p-4">
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          Values and where they came from
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted">
              <tr className="text-left">
                <th className="py-1 pr-4 font-medium">Specification field</th>
                <th className="py-1 pr-4 font-medium">Value</th>
                <th className="py-1 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {withProvenance.map((entry) => (
                <tr key={entry.path} className="border-t border-border">
                  <td className="py-1 pr-4 font-mono text-muted">{entry.path}</td>
                  <td className="py-1 pr-4 text-foreground">{entry.value}</td>
                  <td className="py-1 font-mono text-accent">← {entry.from}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {withProvenance.length === 0 && (
          <p className="text-xs text-muted">
            Nothing stated on this shot yet, so the specification is empty.
          </p>
        )}
      </Card>

      {derived.length > 0 && (
        <Card className="p-4">
          <h3 className="mb-1 text-sm font-semibold text-foreground">Computed by the compiler</h3>
          <p className="mb-2 text-xs text-muted">
            These have no single source field — they are classifications and lists the compiler
            derives from the values above. No provenance is claimed for them.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {derived.map((entry) => (
              <Badge key={entry.path}>
                {entry.path}: {entry.value}
              </Badge>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <h3 className="mb-1 text-sm font-semibold text-foreground">Blocking</h3>
        {blocking ? (
          <pre className="max-h-72 overflow-auto rounded-md bg-surface-2 p-3 text-[11px] text-foreground">
            {JSON.stringify(blocking, null, 2)}
          </pre>
        ) : (
          <p className="text-xs text-muted">This shot has no blocking.</p>
        )}
      </Card>

      {showRaw && (
        <Card className="p-4">
          <h3 className="mb-1 text-sm font-semibold text-foreground">
            Raw CinematicPromptSpec ({MODE_LABEL[mode]})
          </h3>
          <pre className="max-h-96 overflow-auto rounded-md bg-surface-2 p-3 text-[11px] text-foreground">
            {JSON.stringify(specs[mode], null, 2)}
          </pre>
        </Card>
      )}
    </div>
  );
}
