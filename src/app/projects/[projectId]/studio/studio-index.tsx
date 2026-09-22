"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, Button, Card, EmptyState, Field, Select } from "@/components/ui";
import type { ProviderTransparency } from "@/lib/export/types";

export interface StudioRow {
  shotId: string;
  sceneId: string;
  sceneNumber: string;
  slugline: string;
  shotNumber: string;
  shotType: string;
  storyboardAssetId: string | null;
  generations: {
    image: number;
    video: number;
    imageToVideo: number;
    completed: number;
    failed: number;
    running: number;
  };
  savedVersions: number;
  editedVersions: number;
  openFindings: number;
  decidedFindings: number;
  inTimeline: boolean;
  blocked: boolean;
}

type PromptTypeFilter = "any" | "image" | "video" | "imageToVideo";
type StatusFilter = "any" | "generated" | "none" | "failed" | "running";
type ContinuityFilter = "any" | "open" | "clean";

export function StudioIndex({
  projectId,
  rows,
  transparency,
}: {
  projectId: string;
  rows: StudioRow[];
  transparency: ProviderTransparency;
}) {
  const [scene, setScene] = useState("any");
  const [promptType, setPromptType] = useState<PromptTypeFilter>("any");
  const [status, setStatus] = useState<StatusFilter>("any");
  const [continuity, setContinuity] = useState<ContinuityFilter>("any");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const scenes = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.sceneId, `Scene ${row.sceneNumber} — ${row.slugline}`);
    return [...map.entries()];
  }, [rows]);

  const visible = useMemo(
    () =>
      rows.filter((row) => {
        if (scene !== "any" && row.sceneId !== scene) return false;
        if (promptType !== "any" && row.generations[promptType] === 0) return false;
        if (status === "generated" && row.generations.completed === 0) return false;
        if (status === "none" && row.generations.completed > 0) return false;
        if (status === "failed" && row.generations.failed === 0) return false;
        if (status === "running" && row.generations.running === 0) return false;
        if (continuity === "open" && row.openFindings === 0) return false;
        if (continuity === "clean" && row.openFindings > 0) return false;
        return true;
      }),
    [rows, scene, promptType, status, continuity]
  );

  const toggle = (shotId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(shotId)) next.delete(shotId);
      else next.add(shotId);
      return next;
    });

  return (
    <div className="space-y-4">
      {/* Provider transparency, stated up front and carried into every export. */}
      <Card className="p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">AI provider status</h3>
          <Badge tone={transparency.imageProvider.configured ? "green" : "default"}>
            {transparency.imageProvider.configured ? "image provider configured" : "no image key"}
          </Badge>
          {transparency.videoProvider ? (
            <Badge tone={transparency.videoProvider.isStub ? "red" : "green"}>
              {transparency.videoProvider.isStub
                ? "video: LOCAL STUB — placeholder clips, not AI media"
                : `video: ${transparency.videoProvider.label}`}
            </Badge>
          ) : (
            <Badge>no video provider</Badge>
          )}
        </div>
        <p className="text-xs text-muted">{transparency.note}</p>
      </Card>

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold text-foreground">Production export</h3>
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              ["bundle", "Full bundle (.zip)", "Everything, including the media files themselves"],
              ["json", "JSON package", "Complete structured record — pointers to media, not the media"],
              ["csv", "CSV shot list", "Production breakdown"],
              ["pdf", "PDF report", "Human-readable report"],
            ] as Array<[string, string, string]>
          ).map(([format, label, hint]) => (
            <a key={format} href={`/api/projects/${projectId}/export/${format}`} download>
              <Button size="sm" variant="secondary" title={hint}>
                Download {label}
              </Button>
            </a>
          ))}
          <span className="text-xs text-muted">
            Exports read the project; they never change a shot&rsquo;s stored values. The bundle
            carries the asset files; the other three reference them by id and storage key.
          </span>
        </div>
      </Card>

      <Card className="p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="Scene">
            <Select value={scene} onChange={(e) => setScene(e.target.value)}>
              <option value="any">All scenes</option>
              {scenes.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Prompt type generated">
            <Select value={promptType} onChange={(e) => setPromptType(e.target.value as PromptTypeFilter)}>
              <option value="any">Any</option>
              <option value="image">Image</option>
              <option value="video">Video</option>
              <option value="imageToVideo">Image → Video</option>
            </Select>
          </Field>
          <Field label="Generation status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="any">Any</option>
              <option value="generated">Has a completed take</option>
              <option value="none">Nothing generated</option>
              <option value="running">Something running</option>
              <option value="failed">Has a failure</option>
            </Select>
          </Field>
          <Field label="Continuity">
            <Select value={continuity} onChange={(e) => setContinuity(e.target.value as ContinuityFilter)}>
              <option value="any">Any</option>
              <option value="open">Open findings</option>
              <option value="clean">Nothing open</option>
            </Select>
          </Field>
        </div>
        <p className="mt-2 text-xs text-muted">
          Showing {visible.length} of {rows.length} shots.
          {selected.size > 0 && ` ${selected.size} selected.`}
        </p>
      </Card>

      {visible.length === 0 ? (
        <EmptyState
          title="No shots match these filters"
          description="Widen the filters, or add shots in the Shot Builder."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((row) => (
            <Card key={row.shotId} className="overflow-hidden">
              <div className="flex">
                <div className="flex h-24 w-32 shrink-0 items-center justify-center bg-surface-2">
                  {row.storyboardAssetId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/assets/${row.storyboardAssetId}/file`}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="text-[10px] text-muted">no frame</span>
                  )}
                </div>
                <div className="min-w-0 flex-1 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs font-semibold text-foreground">
                        SC{row.sceneNumber} · SHOT {row.shotNumber}
                      </p>
                      <p className="truncate text-xs text-muted">{row.shotType}</p>
                    </div>
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-accent"
                      checked={selected.has(row.shotId)}
                      onChange={() => toggle(row.shotId)}
                      aria-label={`Select shot ${row.shotNumber}`}
                    />
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {row.generations.completed > 0 && (
                      <Badge tone="green">{row.generations.completed} take{row.generations.completed === 1 ? "" : "s"}</Badge>
                    )}
                    {row.generations.running > 0 && <Badge tone="accent">running</Badge>}
                    {row.generations.failed > 0 && <Badge tone="red">{row.generations.failed} failed</Badge>}
                    {row.editedVersions > 0 && <Badge tone="accent">{row.editedVersions} edited</Badge>}
                    {row.openFindings > 0 && <Badge tone="red">{row.openFindings} continuity</Badge>}
                    {row.blocked && <Badge>blocked</Badge>}
                    {row.inTimeline && <Badge>in edit</Badge>}
                  </div>
                  <Link
                    href={`/projects/${projectId}/studio/${row.shotId}`}
                    className="mt-2 inline-block text-xs text-accent hover:underline"
                  >
                    Open in Studio →
                  </Link>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {selected.size > 0 && (
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-foreground">
            Batch ({selected.size} shot{selected.size === 1 ? "" : "s"})
          </h3>
          <p className="mb-3 text-xs text-muted">
            Batch actions name the shots they affect. Nothing regenerates on its own — changing a
            structured value never triggers a generation.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const list = visible
                  .filter((r) => selected.has(r.shotId))
                  .map((r) => `SC${r.sceneNumber} Shot ${r.shotNumber} — ${r.shotType}`)
                  .join("\n");
                void navigator.clipboard.writeText(list);
              }}
            >
              Copy shot list
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
