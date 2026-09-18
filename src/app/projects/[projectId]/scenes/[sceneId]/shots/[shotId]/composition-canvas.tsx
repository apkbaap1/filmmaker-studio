"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, Field, Input, Select } from "@/components/ui";
import {
  axisReport,
  cameraPathPoints,
  describeCameraApproach,
  describeFramePosition,
  pathLength,
  pathSpeed,
  subjectPathPoints,
  toMetres,
  type ShotBlocking,
} from "@/lib/blocking";
import { updateShotBlockingAction } from "@/lib/actions/shots";
import { StageView, subjectColour } from "./stage-view";
import { DEFAULT_OVERLAYS, FrameView, type OverlayToggles } from "./frame-view";
import { FramePreview } from "./frame-preview";

function LegendSwatch({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 rounded bg-surface-2 px-2 py-1 text-muted">
      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: colour }} />
      {label}
    </span>
  );
}

/** Sides of the axis have no inherent meaning — only "same" or "different" matters. */
function sideLabel(side: -1 | 0 | 1): string {
  return side === 0 ? "on the line" : side < 0 ? "A" : "B";
}

/** Numeric control paired with every draggable value, so precision never requires a steady hand. */
function NumberControl({
  label,
  value,
  onChange,
  onCommit,
  min = 0,
  max = 100,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  onCommit: () => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <Field label={label}>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onBlur={onCommit}
      />
    </Field>
  );
}

export function CompositionCanvas({
  projectId,
  sceneId,
  shotId,
  initialBlocking,
  subjectLabel,
  onPromoteComposition,
  cameraHeightLabel,
  cameraMovementLabel,
  durationSeconds,
}: {
  projectId: string;
  sceneId: string;
  shotId: string;
  initialBlocking: ShotBlocking;
  subjectLabel: string;
  onPromoteComposition: (text: string) => void;
  /** Read from the Shot and displayed here. The diagram never writes these back. */
  cameraHeightLabel?: string | null;
  cameraMovementLabel?: string | null;
  durationSeconds?: number | null;
}) {
  const [blocking, setBlocking] = useState<ShotBlocking>(initialBlocking);
  const [overlays, setOverlays] = useState<OverlayToggles>(DEFAULT_OVERLAYS);
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function commit(next: ShotBlocking = blocking) {
    startSaving(async () => {
      const result = await updateShotBlockingAction(projectId, sceneId, shotId, next);
      setError(result?.error);
    });
  }

  function update(next: ShotBlocking) {
    setBlocking(next);
  }

  function updateAndCommit(next: ShotBlocking) {
    setBlocking(next);
    commit(next);
  }

  const camera = blocking.cameraStart;
  const report = axisReport(blocking);
  const axisWarning = report.crosses;

  const camPath = cameraPathPoints(blocking);
  const camPathUnits = pathLength(camPath);
  const camPathMetres = toMetres(camPathUnits, blocking.world);
  // Speed appears only when there is both a real path and a stated duration.
  // A movement label like "Slow" is a feel, not a measurement, and never
  // becomes a number here.
  const speed = pathSpeed(camPath, durationSeconds, blocking.world);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">Top-down blocking</h3>
            <div className="flex items-center gap-2">
              {axisWarning && <Badge tone="red">Camera crosses the 180° axis</Badge>}
              {saving && <span className="text-xs text-muted">Saving…</span>}
            </div>
          </div>
          <StageView
            blocking={blocking}
            onChange={update}
            onCommit={() => commit()}
            showAxis
            cameraHeightLabel={cameraHeightLabel}
          />

          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <LegendSwatch colour="var(--accent)" label="Camera / FOV / camera path" />
            {blocking.subjects.map((s, i) => (
              <LegendSwatch key={s.id} colour={subjectColour(i)} label={s.label} />
            ))}
            <LegendSwatch colour="#a78bfa" label="Prop (foreground)" />
            <LegendSwatch colour="#60a5fa" label="180° axis" />
          </div>

          <div className="mt-2 space-y-0.5 text-xs text-muted">
            <p>Drag the camera, subjects, waypoints and props — or set exact values below.</p>
            <p>
              Camera path: {camPathUnits} stage units
              {camPathMetres !== undefined && ` ≈ ${camPathMetres} m`}
              {camPath.length > 1 && ` · ${camPath.length - 2 >= 0 ? blocking.cameraWaypoints.length : 0} waypoint${blocking.cameraWaypoints.length === 1 ? "" : "s"}`}
              {cameraMovementLabel && ` · shot says “${cameraMovementLabel}”`}
            </p>
            <p>
              {speed
                ? `Speed: ${speed.unitsPerSecond} units/s${speed.metresPerSecond !== undefined ? ` ≈ ${speed.metresPerSecond} m/s` : ""} — from this path over ${durationSeconds}s.`
                : durationSeconds
                  ? "Speed needs a camera path; the duration alone does not give one."
                  : "Speed needs both a camera path and a stated duration — neither is guessed from the movement wording."}
            </p>
            <p>
              Axis:{" "}
              {report.source === "unset"
                ? "none — add a subject, or define one below"
                : report.source === "subject-movement"
                  ? "along the subject's direction of travel"
                  : report.source === "custom"
                    ? "drawn by hand"
                    : report.source === "between-subjects"
                      ? "between two subjects"
                      : "camera-to-subject"}
              {report.endSide !== undefined &&
                ` · camera starts on side ${sideLabel(report.startSide)}, ends on side ${sideLabel(report.endSide)}`}
            </p>
            {describeCameraApproach(blocking, subjectLabel) && (
              <p>{describeCameraApproach(blocking, subjectLabel)}.</p>
            )}
          </div>

          {axisWarning && (
            <p className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
              The camera crosses the 180° axis during this move. That reverses screen direction
              between the head and tail of the shot. It is allowed — cross it deliberately if that
              is the effect you want.
            </p>
          )}
        </Card>

        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">Frame</h3>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onPromoteComposition(describeFramePosition(blocking.frame, subjectLabel))}
            >
              Use as composition text
            </Button>
          </div>
          <FrameView
            blocking={blocking}
            subjectLabel={subjectLabel}
            overlays={overlays}
            onChange={update}
            onCommit={() => commit()}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {(
              [
                ["thirds", "Rule of thirds"],
                ["centre", "Centre lines"],
                ["eyeline", "Eyeline"],
                ["headroom", "Headroom"],
                ["safeArea", "Safe area"],
                ["leadingLines", "Leading lines"],
              ] as Array<[keyof OverlayToggles, string]>
            ).map(([key, label]) => (
              <label
                key={key}
                className="flex items-center gap-1.5 rounded-md bg-surface-2 px-2.5 py-1.5 text-xs text-foreground"
              >
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={overlays[key]}
                  onChange={(e) => setOverlays({ ...overlays, [key]: e.target.checked })}
                />
                {label}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            Overlays are viewing guides — they are not saved to the shot.
          </p>

          <div className="mt-4 border-t border-border pt-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
                Projected from the blocking diagram
              </h4>
              <Badge>derived — move the camera to change it</Badge>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-xs text-muted">At the start of the shot</p>
                <FramePreview
                  blocking={blocking}
                  subjectLabel={subjectLabel}
                  overlays={overlays}
                  at="start"
                />
              </div>
              <div>
                <p className="mb-1 text-xs text-muted">At the end of the camera move</p>
                <FramePreview
                  blocking={blocking}
                  subjectLabel={subjectLabel}
                  overlays={overlays}
                  at="end"
                />
              </div>
            </div>
            <p className="mt-2 text-xs text-muted">
              Horizontal placement is pure geometry from the camera&rsquo;s position, angle and field
              of view — there is no second value to drift. Vertical placement and eyeline come from
              the frame above, because the diagram records no camera or performer height.
            </p>
          </div>
        </Card>
      </div>

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold text-foreground">Exact values</h3>

        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Camera</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NumberControl
            label="Camera X"
            value={camera.x}
            onChange={(x) => update({ ...blocking, cameraStart: { ...camera, x } })}
            onCommit={() => commit()}
            step={0.5}
          />
          <NumberControl
            label="Camera Y"
            value={camera.y}
            onChange={(y) => update({ ...blocking, cameraStart: { ...camera, y } })}
            onCommit={() => commit()}
            step={0.5}
          />
          <NumberControl
            label="Lens direction (°)"
            value={camera.rotation}
            onChange={(rotation) => update({ ...blocking, cameraStart: { ...camera, rotation } })}
            onCommit={() => commit()}
            min={-360}
            max={360}
          />
          <NumberControl
            label="Field of view (°)"
            value={camera.fov}
            onChange={(fov) => update({ ...blocking, cameraStart: { ...camera, fov } })}
            onCommit={() => commit()}
            min={1}
            max={180}
          />
        </div>

        <div className="mt-3">
          {blocking.cameraEnd ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <NumberControl
                label="Camera end X"
                value={blocking.cameraEnd.x}
                onChange={(x) =>
                  update({ ...blocking, cameraEnd: { ...blocking.cameraEnd!, x } })
                }
                onCommit={() => commit()}
                step={0.5}
              />
              <NumberControl
                label="Camera end Y"
                value={blocking.cameraEnd.y}
                onChange={(y) =>
                  update({ ...blocking, cameraEnd: { ...blocking.cameraEnd!, y } })
                }
                onCommit={() => commit()}
                step={0.5}
              />
              <NumberControl
                label="Camera end direction (°)"
                value={blocking.cameraEnd.rotation}
                onChange={(rotation) =>
                  update({ ...blocking, cameraEnd: { ...blocking.cameraEnd!, rotation } })
                }
                onCommit={() => commit()}
                min={-360}
                max={360}
              />
              <div className="flex items-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => updateAndCommit({ ...blocking, cameraEnd: undefined })}
                >
                  Remove camera move
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                updateAndCommit({
                  ...blocking,
                  cameraEnd: { ...camera, y: Math.max(0, camera.y - 20) },
                })
              }
            >
              + Add camera end position
            </Button>
          )}
        </div>

        {/* Camera path waypoints. Only ever added by the filmmaker — a straight
            start-to-end move stays straight. */}
        {blocking.cameraEnd && (
          <div className="mt-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Camera path waypoints
            </p>
            <div className="space-y-2">
              {blocking.cameraWaypoints.map((w, i) => (
                <div key={`cam-wp-${i}`} className="grid grid-cols-3 items-end gap-3">
                  <NumberControl
                    label={`Waypoint ${i + 1} X`}
                    value={w.x}
                    onChange={(x) =>
                      update({
                        ...blocking,
                        cameraWaypoints: blocking.cameraWaypoints.map((p, j) =>
                          j === i ? { ...p, x } : p
                        ),
                      })
                    }
                    onCommit={() => commit()}
                    step={0.5}
                  />
                  <NumberControl
                    label="Y"
                    value={w.y}
                    onChange={(y) =>
                      update({
                        ...blocking,
                        cameraWaypoints: blocking.cameraWaypoints.map((p, j) =>
                          j === i ? { ...p, y } : p
                        ),
                      })
                    }
                    onCommit={() => commit()}
                    step={0.5}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      updateAndCommit({
                        ...blocking,
                        cameraWaypoints: blocking.cameraWaypoints.filter((_, j) => j !== i),
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
              {blocking.cameraWaypoints.length < 8 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    updateAndCommit({
                      ...blocking,
                      cameraWaypoints: [
                        ...blocking.cameraWaypoints,
                        midpoint(blocking.cameraStart, blocking.cameraEnd!),
                      ],
                    })
                  }
                >
                  + Add waypoint
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Subjects. Every character has their own position, facing and path —
            there is no assumption that one of them is the protagonist. */}
        <div className="mt-5 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Subjects</p>
          {blocking.subjects.length < 12 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                updateAndCommit({
                  ...blocking,
                  subjects: [
                    ...blocking.subjects,
                    {
                      id: `subject-${Date.now()}`,
                      label: `Character ${blocking.subjects.length + 1}`,
                      start: { x: 35, y: 45, orientation: 180 },
                      waypoints: [],
                    },
                  ],
                })
              }
            >
              + Add character
            </Button>
          )}
        </div>

        <div className="space-y-4">
          {blocking.subjects.map((subject, index) => (
            <div key={subject.id} className="rounded-md border border-border p-3">
              <div className="mb-2 flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-sm"
                  style={{ background: subjectColour(index) }}
                />
                <Input
                  className="max-w-48"
                  value={subject.label}
                  onChange={(e) =>
                    update({
                      ...blocking,
                      subjects: blocking.subjects.map((s) =>
                        s.id === subject.id ? { ...s, label: e.target.value } : s
                      ),
                    })
                  }
                  onBlur={() => commit()}
                />
                {blocking.subjects.length > 1 && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() =>
                      updateAndCommit({
                        ...blocking,
                        subjects: blocking.subjects.filter((s) => s.id !== subject.id),
                      })
                    }
                  >
                    Remove
                  </Button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <NumberControl
                  label="Start X"
                  value={subject.start.x}
                  onChange={(x) => update(setSubjectStart(blocking, subject.id, { x }))}
                  onCommit={() => commit()}
                  step={0.5}
                />
                <NumberControl
                  label="Start Y"
                  value={subject.start.y}
                  onChange={(y) => update(setSubjectStart(blocking, subject.id, { y }))}
                  onCommit={() => commit()}
                  step={0.5}
                />
                <NumberControl
                  label="Facing (°)"
                  value={subject.start.orientation}
                  onChange={(orientation) =>
                    update(setSubjectStart(blocking, subject.id, { orientation }))
                  }
                  onCommit={() => commit()}
                  min={-360}
                  max={360}
                />
                <div className="flex items-end">
                  {subject.end ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        updateAndCommit({
                          ...blocking,
                          subjects: blocking.subjects.map((s) =>
                            s.id === subject.id ? { ...s, end: undefined, waypoints: [] } : s
                          ),
                        })
                      }
                    >
                      Remove move
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        updateAndCommit({
                          ...blocking,
                          subjects: blocking.subjects.map((s) =>
                            s.id === subject.id
                              ? { ...s, end: { ...s.start, y: Math.min(100, s.start.y + 15) } }
                              : s
                          ),
                        })
                      }
                    >
                      + Add movement
                    </Button>
                  )}
                </div>
              </div>

              {subject.end && (
                <>
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <NumberControl
                      label="End X"
                      value={subject.end.x}
                      onChange={(x) => update(setSubjectEnd(blocking, subject.id, { x }))}
                      onCommit={() => commit()}
                      step={0.5}
                    />
                    <NumberControl
                      label="End Y"
                      value={subject.end.y}
                      onChange={(y) => update(setSubjectEnd(blocking, subject.id, { y }))}
                      onCommit={() => commit()}
                      step={0.5}
                    />
                    <NumberControl
                      label="End facing (°)"
                      value={subject.end.orientation}
                      onChange={(orientation) =>
                        update(setSubjectEnd(blocking, subject.id, { orientation }))
                      }
                      onCommit={() => commit()}
                      min={-360}
                      max={360}
                    />
                    <div className="flex items-end">
                      {subject.waypoints.length < 8 && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            updateAndCommit({
                              ...blocking,
                              subjects: blocking.subjects.map((s) =>
                                s.id === subject.id
                                  ? {
                                      ...s,
                                      waypoints: [...s.waypoints, midpoint(s.start, s.end!)],
                                    }
                                  : s
                              ),
                            })
                          }
                        >
                          + Waypoint
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="mt-1.5 text-xs text-muted">
                    Path: {pathLength(subjectPathPoints(subject))} stage units
                    {subject.waypoints.length > 0 &&
                      ` via ${subject.waypoints.length} waypoint${subject.waypoints.length === 1 ? "" : "s"}`}
                  </p>
                </>
              )}
            </div>
          ))}
        </div>

        {/* The 180° axis — stated, not assumed. */}
        <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-muted">
          180° axis
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Defined by">
            <Select
              value={blocking.axis?.mode ?? "auto"}
              onChange={(e) => {
                const mode = e.target.value as "auto" | "between-subjects" | "subject-movement";
                updateAndCommit({
                  ...blocking,
                  axis:
                    mode === "auto"
                      ? undefined
                      : mode === "subject-movement"
                        ? { mode, subjectId: blocking.subjects[0]?.id }
                        : {
                            mode,
                            subjectIds: blocking.subjects.slice(0, 2).map((s) => s.id),
                          },
                });
              }}
            >
              <option value="auto">Automatic (two subjects, else camera-to-subject)</option>
              <option value="subject-movement">A character&rsquo;s direction of travel</option>
              <option value="between-subjects">Between two characters</option>
            </Select>
          </Field>
          {blocking.axis?.mode === "subject-movement" && (
            <Field label="Whose movement">
              <Select
                value={blocking.axis.subjectId ?? ""}
                onChange={(e) =>
                  updateAndCommit({
                    ...blocking,
                    axis: { mode: "subject-movement", subjectId: e.target.value },
                  })
                }
              >
                {blocking.subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {blocking.axis?.mode === "subject-movement" &&
          !blocking.subjects.find((s) => s.id === blocking.axis?.subjectId)?.end && (
            <p className="mt-1.5 text-xs text-muted">
              That character has no movement yet, so there is no direction of travel to draw a line
              along. Add their end position above.
            </p>
          )}

        {/* World scale. Absent by default: without it, distances stay in stage units. */}
        <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-muted">
          World scale (optional)
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <NumberControl
            label="Stage width (m)"
            value={blocking.world?.widthMetres ?? 0}
            onChange={(widthMetres) =>
              update({
                ...blocking,
                world:
                  widthMetres > 0
                    ? { widthMetres, depthMetres: blocking.world?.depthMetres ?? widthMetres }
                    : undefined,
              })
            }
            onCommit={() => commit()}
            min={0}
            max={1000}
            step={0.5}
          />
          <NumberControl
            label="Stage depth (m)"
            value={blocking.world?.depthMetres ?? 0}
            onChange={(depthMetres) =>
              update({
                ...blocking,
                world:
                  depthMetres > 0 && blocking.world
                    ? { ...blocking.world, depthMetres }
                    : blocking.world,
              })
            }
            onCommit={() => commit()}
            min={0}
            max={1000}
            step={0.5}
          />
          <div className="flex items-end text-xs text-muted">
            {blocking.world
              ? `1 stage unit ≈ ${toMetres(1, blocking.world)} m`
              : "Leave at 0 to keep distances in stage units."}
          </div>
        </div>

        <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Frame</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NumberControl
            label="Subject X in frame"
            value={blocking.frame.subjectX}
            onChange={(subjectX) => update({ ...blocking, frame: { ...blocking.frame, subjectX } })}
            onCommit={() => commit()}
            step={0.5}
          />
          <NumberControl
            label="Subject Y in frame"
            value={blocking.frame.subjectY}
            onChange={(subjectY) => update({ ...blocking, frame: { ...blocking.frame, subjectY } })}
            onCommit={() => commit()}
            step={0.5}
          />
          <NumberControl
            label="Subject size (% height)"
            value={blocking.frame.subjectScale}
            onChange={(subjectScale) => update({ ...blocking, frame: { ...blocking.frame, subjectScale } })}
            onCommit={() => commit()}
            min={1}
          />
          <NumberControl
            label="Eyeline (% height)"
            value={blocking.frame.eyelineY}
            onChange={(eyelineY) => update({ ...blocking, frame: { ...blocking.frame, eyelineY } })}
            onCommit={() => commit()}
          />
        </div>

        <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Props</p>
        <div className="space-y-2">
          {blocking.props.map((prop) => (
            <div key={prop.id} className="grid grid-cols-2 items-end gap-3 sm:grid-cols-5">
              <Field label="Label">
                <Input
                  value={prop.label}
                  onChange={(e) =>
                    update({
                      ...blocking,
                      props: blocking.props.map((p) =>
                        p.id === prop.id ? { ...p, label: e.target.value } : p
                      ),
                    })
                  }
                  onBlur={() => commit()}
                />
              </Field>
              <Field label="Layer">
                <Select
                  value={prop.layer}
                  onChange={(e) => {
                    const next = {
                      ...blocking,
                      props: blocking.props.map((p) =>
                        p.id === prop.id
                          ? { ...p, layer: e.target.value as typeof prop.layer }
                          : p
                      ),
                    };
                    updateAndCommit(next);
                  }}
                >
                  <option value="foreground">Foreground</option>
                  <option value="midground">Midground</option>
                  <option value="background">Background</option>
                </Select>
              </Field>
              <NumberControl
                label="X"
                value={prop.x}
                onChange={(x) =>
                  update({
                    ...blocking,
                    props: blocking.props.map((p) => (p.id === prop.id ? { ...p, x } : p)),
                  })
                }
                onCommit={() => commit()}
                step={0.5}
              />
              <NumberControl
                label="Y"
                value={prop.y}
                onChange={(y) =>
                  update({
                    ...blocking,
                    props: blocking.props.map((p) => (p.id === prop.id ? { ...p, y } : p)),
                  })
                }
                onCommit={() => commit()}
                step={0.5}
              />
              <Button
                variant="danger"
                size="sm"
                onClick={() =>
                  updateAndCommit({
                    ...blocking,
                    props: blocking.props.filter((p) => p.id !== prop.id),
                  })
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              updateAndCommit({
                ...blocking,
                props: [
                  ...blocking.props,
                  {
                    id: `prop-${Date.now()}`,
                    label: "Prop",
                    x: 30,
                    y: 30,
                    layer: "midground" as const,
                  },
                ],
              })
            }
          >
            + Add prop
          </Button>
        </div>

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </Card>
    </div>
  );
}

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: Math.round(((a.x + b.x) / 2) * 10) / 10, y: Math.round(((a.y + b.y) / 2) * 10) / 10 };
}

function setSubjectEnd(
  blocking: ShotBlocking,
  id: string,
  patch: Partial<{ x: number; y: number; orientation: number }>
): ShotBlocking {
  return {
    ...blocking,
    subjects: blocking.subjects.map((s) =>
      s.id === id && s.end ? { ...s, end: { ...s.end, ...patch } } : s
    ),
  };
}

function setSubjectStart(
  blocking: ShotBlocking,
  id: string,
  patch: Partial<{ x: number; y: number; orientation: number }>
): ShotBlocking {
  return {
    ...blocking,
    subjects: blocking.subjects.map((s) =>
      s.id === id ? { ...s, start: { ...s.start, ...patch } } : s
    ),
  };
}
