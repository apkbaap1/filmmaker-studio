"use client";

import { Badge } from "@/components/ui";
import {
  describeFramePosition,
  projectSubjectToFrame,
  scaleAtDistance,
  type ShotBlocking,
} from "@/lib/blocking";
import { FrameView, type OverlayToggles } from "./frame-view";

/**
 * The frame the camera would actually see, projected from the top-down diagram.
 *
 * This is the link that keeps the two views from being two opinions: horizontal
 * placement comes from the camera's position, rotation and field of view, so
 * moving the camera moves the subject in frame with no second value to keep in
 * sync. Vertical placement, subject size and eyeline are carried over from the
 * frame view unchanged, because the diagram records no camera height or
 * performer height to derive them from.
 *
 * At the end of a camera move the subject's size *is* derived — apparent size
 * goes as 1/distance, which needs only the size the filmmaker already set at the
 * start, not an assumption about how tall anyone is.
 */
export function FramePreview({
  blocking,
  subjectLabel,
  overlays,
  at,
}: {
  blocking: ShotBlocking;
  subjectLabel: string;
  overlays: OverlayToggles;
  at: "start" | "end";
}) {
  const camera = at === "start" ? blocking.cameraStart : blocking.cameraEnd;
  const subject = blocking.subjects[0];

  if (!camera || !subject) {
    return (
      <p className="rounded-md border border-border bg-surface-2 p-3 text-xs text-muted">
        {at === "end"
          ? "No camera end position — add one on the diagram to preview the end of the move."
          : "No subject on the stage to project."}
      </p>
    );
  }

  const pose = at === "end" ? (subject.end ?? subject.start) : subject.start;
  const projection = projectSubjectToFrame(camera, pose);

  const startProjection = projectSubjectToFrame(blocking.cameraStart, subject.start);
  const derivedScale =
    at === "end" && !startProjection.outOfFrame
      ? scaleAtDistance(blocking.frame.subjectScale, startProjection.distance, projection.distance)
      : undefined;

  if (projection.outOfFrame || projection.subjectX === undefined) {
    return (
      <div className="rounded-md border border-border bg-surface-2 p-3">
        <Badge tone="red">Subject outside the frame</Badge>
        <p className="mt-2 text-xs text-muted">
          {subject.label} sits {Math.abs(projection.offAxisDegrees).toFixed(1)}° off the lens axis,
          outside the {camera.fov}° field of view. Widen the lens or turn the camera.
        </p>
      </div>
    );
  }

  const projected: ShotBlocking = {
    ...blocking,
    frame: {
      ...blocking.frame,
      subjectX: projection.subjectX,
      subjectScale: derivedScale ?? blocking.frame.subjectScale,
    },
  };

  return (
    <div>
      <FrameView
        blocking={projected}
        subjectLabel={subject.label || subjectLabel}
        overlays={overlays}
        onChange={() => {}}
        onCommit={() => {}}
        readOnly
      />
      <p className="mt-1.5 text-xs text-muted">
        {describeFramePosition(projected.frame, subject.label || subjectLabel)} ·{" "}
        {projection.offAxisDegrees > 0 ? "+" : ""}
        {projection.offAxisDegrees}° off axis · {projection.distance} units from camera
        {derivedScale !== undefined && ` · subject ${derivedScale > blocking.frame.subjectScale ? "larger" : "smaller"} in frame`}
      </p>
    </div>
  );
}
