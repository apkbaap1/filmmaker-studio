"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, ErrorText, Field, Select, Textarea } from "@/components/ui";
import { diffWords, promptsDiffer, summariseDiff } from "@/lib/diff";
import { savePromptVersionAction } from "@/lib/actions/prompt-versions";
import { setContinuityDecisionAction } from "@/lib/actions/continuity";
import type { ProviderTransparency } from "@/lib/export/types";
import { PromptInspector } from "./prompt-inspector";

export type Mode = "IMAGE" | "VIDEO" | "IMAGE_TO_VIDEO";

const MODE_LABEL: Record<Mode, string> = {
  IMAGE: "Image prompt",
  VIDEO: "Text-to-video prompt",
  IMAGE_TO_VIDEO: "Image-to-video prompt",
};

type Tab = "overview" | Mode | "provider" | "inspector";

export interface Overview {
  sceneNumber: string;
  slugline: string;
  shotNumber: string;
  shotType: string;
  description: string | null;
  characters: string[];
  location: string;
  timeOfDay: string;
  camera: string[];
  lens: string | null;
  composition: string | null;
  lighting: string | null;
  mood: string | null;
  durationSeconds: number | null;
  blocking: unknown;
  storyboardAssetId: string | null;
  timeline: {
    sequenceName: string;
    inPointSeconds: number;
    outPointSeconds: number | null;
    transition: string | null;
  } | null;
}

export interface VersionRef {
  id: string;
  mode: Mode;
  version: number;
  source: "COMPILED" | "EDITED";
  text: string;
  promptProviderId: string | null;
  sourceAssetId: string | null;
  label: string | null;
  createdAt: string;
}

export interface GenerationRef {
  id: string;
  mode: Mode;
  status: string;
  source: string;
  promptUsed: string;
  promptEdited: boolean;
  providerId: string;
  durationSeconds: number | null;
  createdAt: string;
  assetId: string | null;
  assetMimeType: string | null;
  assetWidth: number | null;
  assetHeight: number | null;
  assetDurationSeconds: number | null;
  sourceAssetId: string | null;
}

export interface FindingRef {
  key: string;
  category: string;
  severity: string;
  subject: string | null;
  whatChanged: string;
  whyItMayMatter: string;
  status: string | null;
  shotA: string;
  shotB: string;
}

export function ShotStudio({
  projectId,
  sceneId,
  shotId,
  overview,
  prompts,
  specs,
  providerOutputs,
  versions,
  generations,
  sourceFrames,
  findings,
  transparency,
}: {
  projectId: string;
  sceneId: string;
  shotId: string;
  overview: Overview;
  prompts: Record<Mode, { text: string; providerId: string }>;
  specs: Record<Mode, unknown>;
  providerOutputs: Record<Mode, Record<string, { label: string; text: string }>>;
  versions: VersionRef[];
  generations: GenerationRef[];
  sourceFrames: Array<{ id: string; label: string }>;
  findings: FindingRef[];
  transparency: ProviderTransparency;
}) {
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            ["overview", "Overview"],
            ["IMAGE", "Image"],
            ["VIDEO", "Video"],
            ["IMAGE_TO_VIDEO", "Image → Video"],
            ["provider", "Provider"],
            ["inspector", "Inspector"],
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            variant={tab === value ? "primary" : "ghost"}
            onClick={() => setTab(value)}
          >
            {label}
          </Button>
        ))}
      </div>

      {tab === "overview" && (
        <OverviewTab
          projectId={projectId}
          sceneId={sceneId}
          overview={overview}
          generations={generations}
          findings={findings}
        />
      )}

      {(tab === "IMAGE" || tab === "VIDEO" || tab === "IMAGE_TO_VIDEO") && (
        <PromptTab
          projectId={projectId}
          sceneId={sceneId}
          shotId={shotId}
          mode={tab}
          compiled={prompts[tab]}
          versions={versions.filter((v) => v.mode === tab)}
          generations={generations.filter((g) => g.mode === tab)}
          sourceFrames={sourceFrames}
          storyboardAssetId={overview.storyboardAssetId}
        />
      )}

      {tab === "provider" && (
        <ProviderTab outputs={providerOutputs} transparency={transparency} />
      )}

      {tab === "inspector" && <PromptInspector specs={specs} blocking={overview.blocking} />}
    </div>
  );
}

// --- overview ---------------------------------------------------------------

function OverviewTab({
  projectId,
  sceneId,
  overview,
  generations,
  findings,
}: {
  projectId: string;
  sceneId: string;
  overview: Overview;
  generations: GenerationRef[];
  findings: FindingRef[];
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-4">
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-foreground">Shot</h3>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
            <Row label="Scene" value={`${overview.sceneNumber} — ${overview.slugline}`} />
            <Row label="Shot" value={`${overview.shotNumber} · ${overview.shotType}`} />
            <Row label="Description" value={overview.description} />
            <Row label="Characters" value={overview.characters.join(", ") || null} />
            <Row label="Location" value={`${overview.location} · ${overview.timeOfDay}`} />
            <Row label="Camera" value={overview.camera.join(" · ") || null} />
            <Row label="Lens" value={overview.lens} />
            <Row label="Composition" value={overview.composition} />
            <Row label="Lighting" value={overview.lighting} />
            <Row label="Mood" value={overview.mood} />
            <Row
              label="Duration"
              value={overview.durationSeconds ? `${overview.durationSeconds}s` : null}
            />
            <Row label="Blocking" value={blockingSummary(overview.blocking)} />
          </dl>
        </Card>

        {findings.length > 0 && (
          <Card className="p-4">
            <h3 className="mb-1 text-sm font-semibold text-foreground">Continuity</h3>
            <p className="mb-3 text-xs text-muted">
              Shown here for context. Nothing about a finding changes the prompt — you decide what
              to change.
            </p>
            <div className="space-y-2">
              {findings.map((finding) => (
                <div key={finding.key} className="rounded-md border border-border p-2.5">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone={finding.severity === "POTENTIAL_ISSUE" ? "red" : finding.severity === "REVIEW" ? "accent" : "default"}>
                      {finding.severity.replace(/_/g, " ").toLowerCase()}
                    </Badge>
                    <Badge>{finding.category.replace(/_/g, " ").toLowerCase()}</Badge>
                    {finding.status && <Badge tone="accent">{finding.status.toLowerCase()}</Badge>}
                    <span className="font-mono text-xs text-muted">
                      {finding.shotA} → {finding.shotB}
                    </span>
                  </div>
                  <p className="text-xs text-foreground">{finding.whatChanged}</p>
                  <p className="mt-0.5 text-xs text-muted">{finding.whyItMayMatter}</p>
                  <div className="mt-1.5 flex gap-2">
                    <Link href={`/projects/${projectId}/continuity`}>
                      <Button size="sm" variant="secondary">
                        Review
                      </Button>
                    </Link>
                    {finding.status === null && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            await setContinuityDecisionAction(projectId, finding.key, "INTENTIONAL");
                            router.refresh();
                          })
                        }
                      >
                        Mark intentional
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        <AssetsCard projectId={projectId} generations={generations} />
      </div>

      <div className="space-y-4">
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Storyboard frame</h3>
          {overview.storyboardAssetId ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/assets/${overview.storyboardAssetId}/file`}
                alt="Storyboard frame"
                className="aspect-video w-full rounded-md border border-border object-cover"
              />
              <Link
                href={`/projects/${projectId}/storyboard`}
                className="mt-2 inline-block text-xs text-accent hover:underline"
              >
                Open the storyboard →
              </Link>
            </>
          ) : (
            <p className="text-xs text-muted">
              No frame for this shot yet. Generate or upload one from the shot design page.
            </p>
          )}
        </Card>

        {overview.timeline && (
          <Card className="p-4">
            <h3 className="mb-2 text-sm font-semibold text-foreground">In the edit</h3>
            <dl className="grid grid-cols-1 gap-y-1 text-xs">
              <Row label="Sequence" value={overview.timeline.sequenceName} />
              <Row
                label="Trim"
                value={
                  overview.timeline.outPointSeconds === null && overview.timeline.inPointSeconds === 0
                    ? "whole shot"
                    : `in ${overview.timeline.inPointSeconds}s → out ${overview.timeline.outPointSeconds ?? "end"}`
                }
              />
              <Row label="Edit point" value={overview.timeline.transition} />
            </dl>
            <p className="mt-2 text-xs text-muted">
              The trim belongs to the edit. This shot&rsquo;s own duration is unchanged.
            </p>
            <Link
              href={`/projects/${projectId}/timeline`}
              className="mt-1 inline-block text-xs text-accent hover:underline"
            >
              Open the timeline →
            </Link>
          </Card>
        )}

        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Related</h3>
          <div className="flex flex-col gap-1.5 text-xs">
            <Link href={`/projects/${projectId}/scenes/${sceneId}`} className="text-accent hover:underline">
              Shot Builder →
            </Link>
            <Link href={`/projects/${projectId}/continuity`} className="text-accent hover:underline">
              Continuity →
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-foreground">{value ?? <span className="text-muted">not stated</span>}</dd>
    </div>
  );
}

function AssetsCard({
  projectId,
  generations,
}: {
  projectId: string;
  generations: GenerationRef[];
}) {
  const groups: Array<[Mode, GenerationRef[]]> = (["IMAGE", "VIDEO", "IMAGE_TO_VIDEO"] as Mode[])
    .map((mode) => [mode, generations.filter((g) => g.mode === mode)] as [Mode, GenerationRef[]])
    .filter(([, list]) => list.length > 0);

  return (
    <Card className="p-4">
      <h3 className="mb-1 text-sm font-semibold text-foreground">Generated assets</h3>
      <p className="mb-3 text-xs text-muted">
        Every take is kept with the exact prompt that produced it. Nothing is overwritten.
      </p>
      {groups.length === 0 ? (
        <p className="text-xs text-muted">Nothing generated for this shot yet.</p>
      ) : (
        groups.map(([mode, list]) => (
          <div key={mode} className="mb-4 last:mb-0">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
              {MODE_LABEL[mode].replace(" prompt", "")}
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {list.map((generation, index) => (
                <div key={generation.id} className="rounded-md border border-border p-2">
                  <div className="mb-1 flex flex-wrap items-center gap-1">
                    <Badge tone={generation.status === "COMPLETED" ? "green" : generation.status === "FAILED" ? "red" : "accent"}>
                      Take {list.length - index}
                    </Badge>
                    <span className="text-xs text-muted">{generation.status.toLowerCase()}</span>
                  </div>
                  {generation.assetId && generation.assetMimeType?.startsWith("image/") && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/assets/${generation.assetId}/file`}
                      alt=""
                      className="aspect-video w-full rounded object-cover"
                    />
                  )}
                  {generation.assetId && generation.assetMimeType?.startsWith("video/") && (
                    <video
                      src={`/api/assets/${generation.assetId}/file`}
                      controls
                      className="aspect-video w-full rounded bg-black object-contain"
                    />
                  )}
                  <p className="mt-1 text-[11px] text-muted">
                    {generation.providerId}
                    {generation.assetWidth && ` · ${generation.assetWidth}×${generation.assetHeight}`}
                    {generation.assetDurationSeconds &&
                      ` · ${generation.assetDurationSeconds.toFixed(2)}s`}
                    {" · "}
                    {new Date(generation.createdAt).toLocaleString()}
                  </p>
                  {generation.sourceAssetId && (
                    <Link
                      href={`/api/assets/${generation.sourceAssetId}/file`}
                      className="text-[11px] text-accent hover:underline"
                    >
                      source frame
                    </Link>
                  )}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-accent">Prompt used</summary>
                    <p className="mt-1 whitespace-pre-wrap rounded bg-surface-2 p-2 text-[11px] text-foreground">
                      {generation.promptUsed}
                    </p>
                  </details>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
      <Link
        href={`/projects/${projectId}/visualization`}
        className="mt-1 inline-block text-xs text-accent hover:underline"
      >
        All project visuals →
      </Link>
    </Card>
  );
}

// --- prompt tabs -------------------------------------------------------------

function PromptTab({
  projectId,
  sceneId,
  shotId,
  mode,
  compiled,
  versions,
  generations,
  sourceFrames,
  storyboardAssetId,
}: {
  projectId: string;
  sceneId: string;
  shotId: string;
  mode: Mode;
  compiled: { text: string; providerId: string };
  versions: VersionRef[];
  generations: GenerationRef[];
  sourceFrames: Array<{ id: string; label: string }>;
  storyboardAssetId: string | null;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(compiled.text);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const [compareA, setCompareA] = useState<string>("");
  const [compareB, setCompareB] = useState<string>("");

  const edited = promptsDiffer(draft, compiled.text);
  const latest = versions[0];
  /**
   * Change impact: a saved version written against an older specification is
   * flagged rather than silently replaced. The filmmaker chooses which to use.
   */
  const compiledMovedOn = latest ? promptsDiffer(latest.text, compiled.text) : false;

  const save = () =>
    startTransition(async () => {
      setError(undefined);
      const result = await savePromptVersionAction(projectId, sceneId, shotId, mode, draft);
      if (result?.error) setError(result.error);
      else router.refresh();
    });

  const byId = useMemo(
    () => new Map(versions.map((v) => [v.id, v])),
    [versions]
  );
  const a = compareA === "compiled" ? compiled.text : byId.get(compareA)?.text;
  const b = compareB === "compiled" ? compiled.text : byId.get(compareB)?.text;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{MODE_LABEL[mode]}</h3>
          <Badge tone={edited ? "accent" : "green"}>{edited ? "EDITED" : "COMPILED"}</Badge>
          <Badge>{compiled.providerId}</Badge>
        </div>

        {/* Provenance: which systems this prompt was compiled from. */}
        <p className="mb-3 text-xs text-muted">
          Compiled from Shot {shotId.slice(-6)} + Scene + Visual Canvas + Camera Blocking +
          Character data. Values you left blank do not appear. Switch to the Inspector to see which
          field every sentence came from.
        </p>

        {mode === "IMAGE_TO_VIDEO" && (
          <div className="mb-3 flex flex-wrap items-start gap-3">
            {(sourceFrames[0] || storyboardAssetId) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/assets/${sourceFrames[0]?.id ?? storyboardAssetId}/file`}
                alt="Source frame"
                className="h-20 w-32 rounded border border-border object-cover"
              />
            )}
            <p className="max-w-md text-xs text-muted">
              {sourceFrames.length > 0
                ? "The frame this prompt animates. Choose a different one when generating, on the shot design page."
                : "No source frame yet — image-to-video needs one. Generate or upload an image for this shot first."}
            </p>
          </div>
        )}

        {editing ? (
          <Textarea rows={14} value={draft} onChange={(e) => setDraft(e.target.value)} />
        ) : (
          <p className="whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-xs text-foreground">
            {draft || "Nothing specified yet — fill in the shot's fields."}
          </p>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setEditing((v) => !v)}>
            {editing ? "Done editing" : "Edit"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(draft);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button size="sm" disabled={pending || draft.trim().length < 3} onClick={save}>
            Save version
          </Button>
          {edited && (
            <Button size="sm" variant="ghost" onClick={() => setDraft(compiled.text)}>
              Reset to compiled
            </Button>
          )}
          <Link href={`/projects/${projectId}/scenes/${sceneId}/shots/${shotId}`}>
            <Button size="sm" variant="ghost">
              Generate on the shot page →
            </Button>
          </Link>
        </div>
        <ErrorText message={error} />
      </Card>

      {compiledMovedOn && (
        <Card className="border-accent/40 p-4">
          <h3 className="mb-1 text-sm font-semibold text-foreground">
            The compiled prompt has changed since version {latest.version}
          </h3>
          <p className="text-xs text-muted">
            A structured value on this shot changed after that version was saved. Existing generated
            assets stay exactly as they are — they keep the prompt that produced them. Nothing has
            been overwritten: use the new compiled prompt, or keep the saved one.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setDraft(compiled.text)}>
              Use new compiled prompt
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(latest.text)}>
              Keep version {latest.version}
            </Button>
          </div>
        </Card>
      )}

      <Card className="p-4">
        <h3 className="mb-1 text-sm font-semibold text-foreground">Version history</h3>
        <p className="mb-3 text-xs text-muted">
          Saved drafts. The exact text of each generation is recorded separately on its take and is
          never rewritten.
        </p>
        {versions.length === 0 ? (
          <p className="text-xs text-muted">No saved versions yet.</p>
        ) : (
          <div className="space-y-2">
            {versions.map((version) => (
              <div key={version.id} className="rounded-md border border-border p-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={version.source === "EDITED" ? "accent" : "default"}>
                    Version {version.version}
                  </Badge>
                  <Badge>{version.source}</Badge>
                  <span className="text-xs text-muted">
                    {new Date(version.createdAt).toLocaleString()}
                    {version.promptProviderId && ` · ${version.promptProviderId}`}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => setDraft(version.text)}
                  >
                    Load
                  </Button>
                </div>
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-accent">Show text</summary>
                  <p className="mt-1 whitespace-pre-wrap rounded bg-surface-2 p-2 text-xs text-foreground">
                    {version.text}
                  </p>
                </details>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="mb-1 text-sm font-semibold text-foreground">Compare</h3>
        <p className="mb-3 text-xs text-muted">
          Word-level comparison, computed deterministically — the same two versions always produce
          the same result.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Version A">
            <Select value={compareA} onChange={(e) => setCompareA(e.target.value)}>
              <option value="">Choose…</option>
              <option value="compiled">Current compiled</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  Version {v.version} ({v.source.toLowerCase()})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Version B">
            <Select value={compareB} onChange={(e) => setCompareB(e.target.value)}>
              <option value="">Choose…</option>
              <option value="compiled">Current compiled</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  Version {v.version} ({v.source.toLowerCase()})
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {a !== undefined && b !== undefined && (
          <div className="mt-3">
            <p className="mb-1.5 text-xs text-muted">
              {(() => {
                const s = summariseDiff(a, b);
                return s.changed
                  ? `${s.addedWords} word${s.addedWords === 1 ? "" : "s"} added, ${s.removedWords} removed.`
                  : "Identical.";
              })()}
            </p>
            <p className="whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-xs leading-relaxed">
              {diffWords(a, b).map((part, i) => (
                <span
                  key={i}
                  className={
                    part.op === "added"
                      ? "bg-green-500/25 text-green-200"
                      : part.op === "removed"
                        ? "bg-red-500/25 text-red-200 line-through"
                        : "text-foreground"
                  }
                >
                  {part.value}
                </span>
              ))}
            </p>
          </div>
        )}
      </Card>

      {generations.length > 0 && (
        <Card className="p-4">
          <h3 className="mb-1 text-sm font-semibold text-foreground">
            Takes from this prompt type
          </h3>
          <p className="mb-3 text-xs text-muted">
            Each keeps the exact text that produced it, whatever the prompt says now.
          </p>
          <div className="space-y-1.5">
            {generations.map((generation) => (
              <div key={generation.id} className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone={generation.status === "COMPLETED" ? "green" : "red"}>
                  {generation.status.toLowerCase()}
                </Badge>
                {generation.promptEdited && <Badge tone="accent">edited prompt</Badge>}
                <span className="text-muted">
                  {new Date(generation.createdAt).toLocaleString()} · {generation.providerId}
                </span>
                <span className="text-muted">
                  {promptsDiffer(generation.promptUsed, compiled.text)
                    ? "differs from the current compiled prompt"
                    : "matches the current compiled prompt"}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// --- provider ----------------------------------------------------------------

function ProviderTab({
  outputs,
  transparency,
}: {
  outputs: Record<Mode, Record<string, { label: string; text: string }>>;
  transparency: ProviderTransparency;
}) {
  const adapterIds = Object.keys(outputs.IMAGE);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h3 className="mb-2 text-sm font-semibold text-foreground">Provider-specific output</h3>
        <p className="text-xs text-muted">
          Only adapters that actually exist in this codebase are listed. There is no Seedance, Veo,
          Higgsfield or Runway adapter here, so none is shown and nothing claims to be optimised for
          them. Adding one means writing an adapter against the provider interface — the
          provider-independent specification does not change.
        </p>
        <p className="mt-2 text-xs text-muted">{transparency.note}</p>
      </Card>

      {adapterIds.map((id) => (
        <Card key={id} className="p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{outputs.IMAGE[id].label}</h3>
            <Badge>{id}</Badge>
          </div>
          {(["IMAGE", "VIDEO", "IMAGE_TO_VIDEO"] as Mode[]).map((mode) => (
            <div key={mode} className="mb-3 last:mb-0">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                {MODE_LABEL[mode]}
              </p>
              <p className="whitespace-pre-wrap rounded-md bg-surface-2 p-2.5 text-xs text-foreground">
                {outputs[mode][id].text}
              </p>
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}

function blockingSummary(blocking: unknown): string | null {
  if (!blocking) return null;
  const b = blocking as {
    subjects?: Array<{ label: string }>;
    props?: Array<{ label: string }>;
    cameraEnd?: unknown;
  };
  const parts: string[] = [];
  if (b.subjects?.length) parts.push(`${b.subjects.map((s) => s.label).join(", ")}`);
  if (b.props?.length) parts.push(`props: ${b.props.map((p) => p.label).join(", ")}`);
  parts.push(b.cameraEnd ? "camera moves" : "camera static");
  return parts.join(" · ");
}
