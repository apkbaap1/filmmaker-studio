"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import {
  clearContinuityDecisionAction,
  setContinuityDecisionAction,
} from "@/lib/actions/continuity";
import type {
  CharacterTimelineEntry,
  ContinuityFinding,
  DecisionStatus,
  FindingCategory,
  PropTimelineEntry,
  Severity,
} from "@/lib/continuity";

type ShotRef = { shotNumber: string; shotType: string; sceneId: string; sceneNumber: string };
type SceneRef = { number: string; slugline: string };

const SEVERITY_TONE: Record<Severity, "red" | "accent" | "default"> = {
  POTENTIAL_ISSUE: "red",
  REVIEW: "accent",
  INFO: "default",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  POTENTIAL_ISSUE: "Potential issue",
  REVIEW: "Review",
  INFO: "Info",
};

const CATEGORY_LABEL: Record<FindingCategory, string> = {
  WARDROBE: "Wardrobe",
  HAIR_MAKEUP: "Hair & makeup",
  CHARACTER_PROPS: "Props carried",
  CHARACTER_PRESENCE: "Character presence",
  LOCATION: "Location",
  TIME_OF_DAY: "Time of day",
  LIGHTING: "Lighting",
  PROP: "Set props",
  AXIS: "180° axis",
  SCREEN_DIRECTION: "Screen direction",
  EYELINE: "Eyeline",
  CAMERA: "Camera",
};

/** Which grouping the findings are read through. */
type GroupBy = "category" | "scene" | "character" | "prop" | "camera";

const STATUS_LABEL: Record<DecisionStatus, string> = {
  REVIEWED: "Reviewed",
  INTENTIONAL: "Intentional",
  DISMISSED: "Dismissed",
};

export function ContinuityPanel({
  projectId,
  findings,
  shots,
  scenes,
  characterTimelines,
  propTimelines,
}: {
  projectId: string;
  findings: ContinuityFinding[];
  shots: Record<string, ShotRef>;
  scenes: Record<string, SceneRef>;
  characterTimelines: Record<string, CharacterTimelineEntry[]>;
  propTimelines: Record<string, PropTimelineEntry[]>;
}) {
  const [groupBy, setGroupBy] = useState<GroupBy>("category");
  const [showDecided, setShowDecided] = useState(false);

  const visible = useMemo(
    () => (showDecided ? findings : findings.filter((f) => f.status === undefined)),
    [findings, showDecided]
  );

  const counts = useMemo(() => {
    const open = findings.filter((f) => f.status === undefined);
    return {
      total: findings.length,
      open: open.length,
      issues: open.filter((f) => f.severity === "POTENTIAL_ISSUE").length,
      review: open.filter((f) => f.severity === "REVIEW").length,
      info: open.filter((f) => f.severity === "INFO").length,
      decided: findings.length - open.length,
    };
  }, [findings]);

  /**
   * Findings are grouped rather than listed flat, because a wall of individual
   * warnings is how a continuity tool stops being read.
   */
  const groups = useMemo(() => {
    const map = new Map<string, ContinuityFinding[]>();
    for (const finding of visible) {
      let bucket: string | undefined;
      switch (groupBy) {
        case "category":
          bucket = CATEGORY_LABEL[finding.category];
          break;
        case "scene":
          bucket = sceneNameFor(finding, shots, scenes);
          break;
        case "character":
          bucket = isCharacterFinding(finding) ? finding.subject ?? "Character" : undefined;
          break;
        case "prop":
          bucket = finding.category === "PROP" ? finding.subject ?? "Prop" : undefined;
          break;
        case "camera":
          bucket = ["AXIS", "SCREEN_DIRECTION", "EYELINE", "CAMERA"].includes(finding.category)
            ? CATEGORY_LABEL[finding.category]
            : undefined;
          break;
      }
      if (!bucket) continue;
      map.set(bucket, [...(map.get(bucket) ?? []), finding]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible, groupBy, shots, scenes]);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={counts.issues > 0 ? "red" : "green"}>
            {counts.issues} potential issue{counts.issues === 1 ? "" : "s"}
          </Badge>
          <Badge tone="accent">{counts.review} to review</Badge>
          <Badge>{counts.info} info</Badge>
          {counts.decided > 0 && <Badge>{counts.decided} decided</Badge>}
        </div>
        <p className="mt-2 text-xs text-muted">
          Compared between consecutive shots in a scene, and between shots you placed next to each
          other in an edit. A blank field is never read as &ldquo;none&rdquo;, and a difference is
          never called an error &mdash; shots are meant to differ.
        </p>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["category", "By category"],
            ["scene", "By scene"],
            ["character", "By character"],
            ["prop", "By prop"],
            ["camera", "By camera / axis"],
          ] as Array<[GroupBy, string]>
        ).map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            variant={groupBy === value ? "primary" : "ghost"}
            onClick={() => setGroupBy(value)}
          >
            {label}
          </Button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 rounded-md bg-surface-2 px-2.5 py-1.5 text-xs text-foreground">
          <input
            type="checkbox"
            className="accent-accent"
            checked={showDecided}
            onChange={(e) => setShowDecided(e.target.checked)}
          />
          Show decided
        </label>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          title={
            counts.open === 0 && counts.total > 0
              ? "Everything here has been decided"
              : "Nothing to flag"
          }
          description={
            counts.total === 0
              ? "No differences worth reporting between your related shots. Fill in wardrobe, lighting and blocking on more shots to give continuity more to compare."
              : "Switch grouping, or turn on “Show decided” to see findings you have already handled."
          }
        />
      ) : (
        groups.map(([name, groupFindings]) => (
          <Card key={name} className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">{name}</h3>
              <Badge>{groupFindings.length}</Badge>
            </div>
            <div className="space-y-3">
              {groupFindings.map((finding) => (
                <FindingRow
                  key={finding.key}
                  projectId={projectId}
                  finding={finding}
                  shots={shots}
                />
              ))}
            </div>
          </Card>
        ))
      )}

      {Object.keys(characterTimelines).length > 0 && (
        <Card className="p-4">
          <h3 className="mb-1 text-sm font-semibold text-foreground">Character continuity</h3>
          <p className="mb-3 text-xs text-muted">
            Read the progression yourself rather than only being told about differences.
          </p>
          {Object.entries(characterTimelines).map(([name, entries]) => (
            <div key={name} className="mb-4 last:mb-0">
              <p className="mb-1.5 font-mono text-xs font-semibold uppercase text-foreground">
                {name}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted">
                    <tr className="text-left">
                      <th className="py-1 pr-3 font-medium">Shot</th>
                      <th className="py-1 pr-3 font-medium">Wardrobe</th>
                      <th className="py-1 pr-3 font-medium">Hair &amp; makeup</th>
                      <th className="py-1 pr-3 font-medium">Carried</th>
                      <th className="py-1 pr-3 font-medium">Location</th>
                      <th className="py-1 font-medium">In frame</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <tr key={entry.shotId} className="border-t border-border text-foreground">
                        <td className="py-1 pr-3 font-mono">
                          {entry.sceneNumber}/{entry.shotNumber}
                        </td>
                        <Cell value={entry.wardrobe} />
                        <Cell value={entry.hairMakeup} />
                        <Cell value={entry.carriedProps} />
                        <Cell value={entry.location} />
                        <Cell value={entry.present === "blocked" ? entry.framePosition : undefined} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </Card>
      )}

      {Object.keys(propTimelines).length > 0 && (
        <Card className="p-4">
          <h3 className="mb-1 text-sm font-semibold text-foreground">Prop continuity</h3>
          <p className="mb-3 text-xs text-muted">
            <span className="text-foreground">Unspecified</span> means the shot places no props at
            all &mdash; it is not the same as the prop being absent.
          </p>
          <div className="space-y-3">
            {Object.entries(propTimelines).map(([name, entries]) => (
              <div key={name}>
                <p className="mb-1.5 font-mono text-xs font-semibold uppercase text-foreground">
                  {name}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {entries.map((entry) => (
                    <span
                      key={entry.shotId}
                      className={[
                        "rounded px-2 py-1 text-xs",
                        entry.presence === "present"
                          ? "bg-green-500/15 text-green-300"
                          : entry.presence === "absent"
                            ? "bg-red-500/15 text-red-300"
                            : "bg-surface-2 text-muted",
                      ].join(" ")}
                    >
                      <span className="font-mono">
                        {entry.sceneNumber}/{entry.shotNumber}
                      </span>{" "}
                      {entry.presence}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function Cell({ value }: { value?: string }) {
  return (
    <td className="py-1 pr-3">
      {value ?? <span className="text-muted">not stated</span>}
    </td>
  );
}

function FindingRow({
  projectId,
  finding,
  shots,
}: {
  projectId: string;
  finding: ContinuityFinding;
  shots: Record<string, ShotRef>;
}) {
  const [pending, startTransition] = useTransition();
  const a = shots[finding.shotAId];
  const b = shots[finding.shotBId];

  const decide = (status: DecisionStatus) =>
    startTransition(async () => {
      await setContinuityDecisionAction(projectId, finding.key, status);
    });

  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <Badge tone={SEVERITY_TONE[finding.severity]}>{SEVERITY_LABEL[finding.severity]}</Badge>
        <Badge>{CATEGORY_LABEL[finding.category]}</Badge>
        {finding.subject && <Badge tone="accent">{finding.subject}</Badge>}
        {finding.status && <Badge>{STATUS_LABEL[finding.status]}</Badge>}
        <span className="text-xs text-muted">
          {finding.relation === "adjacent-in-edit" ? "adjacent in the edit" : "consecutive in scene"}
        </span>
      </div>

      <p className="font-mono text-xs text-muted">
        Shot {a?.shotNumber ?? finding.shotAId} → Shot {b?.shotNumber ?? finding.shotBId}
      </p>
      <p className="mt-1 text-sm text-foreground">{finding.whatChanged}</p>
      <p className="mt-1 text-xs text-muted">{finding.whyItMayMatter}</p>

      <div className="mt-2 flex flex-wrap gap-2">
        {a && (
          <Link href={`/projects/${projectId}/scenes/${a.sceneId}/shots/${finding.shotAId}`}>
            <Button size="sm" variant="secondary" disabled={pending}>
              Review shot {a.shotNumber}
            </Button>
          </Link>
        )}
        {b && (
          <Link href={`/projects/${projectId}/scenes/${b.sceneId}/shots/${finding.shotBId}`}>
            <Button size="sm" variant="secondary" disabled={pending}>
              Review shot {b.shotNumber}
            </Button>
          </Link>
        )}
        {finding.status === undefined ? (
          <>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => decide("INTENTIONAL")}>
              Mark intentional
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => decide("DISMISSED")}>
              Dismiss
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await clearContinuityDecisionAction(projectId, finding.key);
              })
            }
          >
            Reopen
          </Button>
        )}
      </div>
    </div>
  );
}

function isCharacterFinding(finding: ContinuityFinding): boolean {
  return [
    "WARDROBE",
    "HAIR_MAKEUP",
    "CHARACTER_PROPS",
    "CHARACTER_PRESENCE",
    "SCREEN_DIRECTION",
    "EYELINE",
  ].includes(finding.category);
}

function sceneNameFor(
  finding: ContinuityFinding,
  shots: Record<string, ShotRef>,
  scenes: Record<string, SceneRef>
): string {
  const shot = shots[finding.shotAId];
  const scene = shot ? scenes[shot.sceneId] : undefined;
  return scene ? `Scene ${scene.number} — ${scene.slugline}` : "Across scenes";
}
