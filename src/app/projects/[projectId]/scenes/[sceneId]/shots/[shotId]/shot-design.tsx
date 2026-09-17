"use client";

import { useActionState, useId, useState } from "react";
import { Button, Card, ErrorText, Field, Input } from "@/components/ui";
import { updateShotTemporalAction } from "@/lib/actions/shots";
import type { FormState } from "@/lib/actions/shots";
import type { ShotBlocking } from "@/lib/blocking";
import { CompositionCanvas } from "./composition-canvas";

const CAMERA_MOVEMENTS = [
  "Static", "Pan", "Tilt", "Dolly In", "Dolly Out", "Tracking", "Truck Left", "Truck Right",
  "Crane Up", "Crane Down", "Pedestal", "Orbit", "Arc", "Push In", "Pull Out", "Handheld",
  "Steadicam", "Gimbal", "Drone", "Whip Pan", "Rack Focus",
];

export interface TemporalValues {
  composition: string;
  finalComposition: string;
  framing: string;
  initialFraming: string;
  finalFraming: string;
  cameraMovement: string;
  movementSpeed: string;
  cameraStartPosition: string;
  cameraEndPosition: string;
  subjectMovement: string;
  subjectStartPosition: string;
  subjectEndPosition: string;
  environmentalMovement: string;
  durationSeconds: string;
}

function SuggestInput({
  name,
  options,
  value,
  onChange,
  placeholder,
}: {
  name: string;
  options: string[];
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const listId = useId();
  return (
    <>
      <Input name={name} list={listId} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}

/**
 * Shot design surface: the canvas plus the temporal controls that feed the
 * Phase 3 compiler. Both edit the same ShotListItem row — there is no separate
 * visualization state to drift out of sync.
 */
export function ShotDesign({
  projectId,
  sceneId,
  shotId,
  initialBlocking,
  subjectLabel,
  initialValues,
}: {
  projectId: string;
  sceneId: string;
  shotId: string;
  initialBlocking: ShotBlocking;
  subjectLabel: string;
  initialValues: TemporalValues;
}) {
  const [values, setValues] = useState<TemporalValues>(initialValues);
  const boundAction = updateShotTemporalAction.bind(null, projectId, sceneId, shotId);
  const [state, formAction, pending] = useActionState<FormState, FormData>(boundAction, undefined);

  const set = (key: keyof TemporalValues) => (next: string) =>
    setValues((v) => ({ ...v, [key]: next }));

  const hasFramingTransition = Boolean(values.finalFraming.trim());
  const hasCompositionTransition = Boolean(values.finalComposition.trim());

  return (
    <div className="space-y-6">
      <CompositionCanvas
        projectId={projectId}
        sceneId={sceneId}
        shotId={shotId}
        initialBlocking={initialBlocking}
        subjectLabel={subjectLabel}
        onPromoteComposition={(text) => set("composition")(text)}
      />

      <Card className="p-5">
        <h3 className="mb-1 text-sm font-semibold text-foreground">Temporal &amp; compositional state</h3>
        <p className="mb-4 text-xs text-muted">
          A transition exists only if you state it. Leaving a final value empty means that axis holds
          for the whole shot — camera movement alone never implies a framing or composition change.
        </p>

        <form action={formAction} className="space-y-5">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Composition — spatial placement
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Composition">
                <Input
                  name="composition"
                  value={values.composition}
                  onChange={(e) => set("composition")(e.target.value)}
                  placeholder="Ravi on the left third"
                />
              </Field>
              <Field label="Final composition (only if placement changes)">
                <Input
                  name="finalComposition"
                  value={values.finalComposition}
                  onChange={(e) => set("finalComposition")(e.target.value)}
                  placeholder="Leave empty to hold the composition"
                />
              </Field>
            </div>
            <p className="mt-1.5 text-xs text-muted">
              {hasCompositionTransition
                ? "Composition will be marked as changing over the shot."
                : "Composition will be preserved for the whole shot."}
            </p>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Framing — shot scale
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Framing">
                <Input
                  name="framing"
                  value={values.framing}
                  onChange={(e) => set("framing")(e.target.value)}
                  placeholder="Tight"
                />
              </Field>
              <Field label="Initial framing (only if it changes)">
                <Input
                  name="initialFraming"
                  value={values.initialFraming}
                  onChange={(e) => set("initialFraming")(e.target.value)}
                  placeholder="Wide"
                />
              </Field>
              <Field label="Final framing (only if it changes)">
                <Input
                  name="finalFraming"
                  value={values.finalFraming}
                  onChange={(e) => set("finalFraming")(e.target.value)}
                  placeholder="Tight"
                />
              </Field>
            </div>
            <p className="mt-1.5 text-xs text-muted">
              {hasFramingTransition
                ? "Framing will be marked as progressing over the shot."
                : "Framing will be preserved for the whole shot."}
            </p>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Camera</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <Field label="Camera movement">
                <SuggestInput
                  name="cameraMovement"
                  options={CAMERA_MOVEMENTS}
                  value={values.cameraMovement}
                  onChange={set("cameraMovement")}
                  placeholder="Dolly In"
                />
              </Field>
              <Field label="Movement speed">
                <Input
                  name="movementSpeed"
                  value={values.movementSpeed}
                  onChange={(e) => set("movementSpeed")(e.target.value)}
                  placeholder="Slow"
                />
              </Field>
              <Field label="Camera start position">
                <Input
                  name="cameraStartPosition"
                  value={values.cameraStartPosition}
                  onChange={(e) => set("cameraStartPosition")(e.target.value)}
                  placeholder="4m back, platform edge"
                />
              </Field>
              <Field label="Camera end position">
                <Input
                  name="cameraEndPosition"
                  value={values.cameraEndPosition}
                  onChange={(e) => set("cameraEndPosition")(e.target.value)}
                  placeholder="1m from subject"
                />
              </Field>
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Subject</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Subject movement">
                <Input
                  name="subjectMovement"
                  value={values.subjectMovement}
                  onChange={(e) => set("subjectMovement")(e.target.value)}
                  placeholder="Turns toward camera"
                />
              </Field>
              <Field label="Subject start position">
                <Input
                  name="subjectStartPosition"
                  value={values.subjectStartPosition}
                  onChange={(e) => set("subjectStartPosition")(e.target.value)}
                  placeholder="Mid-platform, back to camera"
                />
              </Field>
              <Field label="Subject end position">
                <Input
                  name="subjectEndPosition"
                  value={values.subjectEndPosition}
                  onChange={(e) => set("subjectEndPosition")(e.target.value)}
                  placeholder="Facing camera, centre frame"
                />
              </Field>
              <Field label="Environmental movement">
                <Input
                  name="environmentalMovement"
                  value={values.environmentalMovement}
                  onChange={(e) => set("environmentalMovement")(e.target.value)}
                  placeholder="Light fog drifting through the station"
                />
              </Field>
              <Field label="Duration (seconds)">
                <Input
                  name="durationSeconds"
                  type="number"
                  min="0"
                  step="0.1"
                  value={values.durationSeconds}
                  onChange={(e) => set("durationSeconds")(e.target.value)}
                  placeholder="6"
                />
              </Field>
            </div>
          </div>

          <ErrorText message={state?.error} />
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save shot design"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
