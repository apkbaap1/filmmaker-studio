"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, Field, Input, Select } from "@/components/ui";
import {
  crossesAxis,
  describeFramePosition,
  type ShotBlocking,
} from "@/lib/blocking";
import { updateShotBlockingAction } from "@/lib/actions/shots";
import { StageView } from "./stage-view";
import { DEFAULT_OVERLAYS, FrameView, type OverlayToggles } from "./frame-view";

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
}: {
  projectId: string;
  sceneId: string;
  shotId: string;
  initialBlocking: ShotBlocking;
  subjectLabel: string;
  onPromoteComposition: (text: string) => void;
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
  const primarySubject = blocking.subjects[0];
  const axisWarning = crossesAxis(blocking);

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
          <StageView blocking={blocking} onChange={update} onCommit={() => commit()} showAxis />
          <p className="mt-2 text-xs text-muted">
            Drag the camera, subjects and props — or set exact values in the panel below.
          </p>
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
                label="End X"
                value={blocking.cameraEnd.x}
                onChange={(x) =>
                  update({ ...blocking, cameraEnd: { ...blocking.cameraEnd!, x } })
                }
                onCommit={() => commit()}
                step={0.5}
              />
              <NumberControl
                label="End Y"
                value={blocking.cameraEnd.y}
                onChange={(y) =>
                  update({ ...blocking, cameraEnd: { ...blocking.cameraEnd!, y } })
                }
                onCommit={() => commit()}
                step={0.5}
              />
              <NumberControl
                label="End direction (°)"
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

        {primarySubject && (
          <>
            <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-muted">
              {primarySubject.label}
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <NumberControl
                label="Subject X"
                value={primarySubject.start.x}
                onChange={(x) => update(setSubjectStart(blocking, primarySubject.id, { x }))}
                onCommit={() => commit()}
                step={0.5}
              />
              <NumberControl
                label="Subject Y"
                value={primarySubject.start.y}
                onChange={(y) => update(setSubjectStart(blocking, primarySubject.id, { y }))}
                onCommit={() => commit()}
                step={0.5}
              />
              <NumberControl
                label="Facing (°)"
                value={primarySubject.start.orientation}
                onChange={(orientation) =>
                  update(setSubjectStart(blocking, primarySubject.id, { orientation }))
                }
                onCommit={() => commit()}
                min={-360}
                max={360}
              />
              <div className="flex items-end">
                {primarySubject.end ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      updateAndCommit({
                        ...blocking,
                        subjects: blocking.subjects.map((s) =>
                          s.id === primarySubject.id ? { ...s, end: undefined } : s
                        ),
                      })
                    }
                  >
                    Remove subject move
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      updateAndCommit({
                        ...blocking,
                        subjects: blocking.subjects.map((s) =>
                          s.id === primarySubject.id
                            ? { ...s, end: { ...s.start, y: Math.min(100, s.start.y + 15) } }
                            : s
                        ),
                      })
                    }
                  >
                    + Subject end position
                  </Button>
                )}
              </div>
            </div>
          </>
        )}

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
