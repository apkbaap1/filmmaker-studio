"use client";

import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  axisReport,
  axisSide,
  cameraPathPoints,
  fieldOfViewEdges,
  subjectPathPoints,
  type Point,
  type ShotBlocking,
} from "@/lib/blocking";

type DragTarget =
  | { kind: "cameraStart" }
  | { kind: "cameraEnd" }
  | { kind: "cameraWaypoint"; index: number }
  | { kind: "subjectStart"; id: string }
  | { kind: "subjectEnd"; id: string }
  | { kind: "subjectWaypoint"; id: string; index: number }
  | { kind: "prop"; id: string };

/** One colour per subject, so a two-hander is readable at a glance. */
const SUBJECT_COLOURS = ["#34d399", "#f472b6", "#facc15", "#38bdf8", "#fb923c", "#a3e635"];

export function subjectColour(index: number): string {
  return SUBJECT_COLOURS[index % SUBJECT_COLOURS.length];
}

function polyline(points: Point[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(" ");
}

/**
 * Top-down camera-blocking diagram.
 *
 * Draws the one spatial record the shot has: camera path, per-subject paths,
 * props, field of view and the 180° axis. Drag is one way to edit; every value
 * it changes is also editable as a number in the panel beside it, so precise
 * work never depends on dragging accurately.
 */
export function StageView({
  blocking,
  onChange,
  onCommit,
  showAxis,
  cameraHeightLabel,
}: {
  blocking: ShotBlocking;
  onChange: (next: ShotBlocking) => void;
  onCommit: () => void;
  showAxis: boolean;
  /** The shot's own camera-height wording, labelled on the camera. Read-only here. */
  cameraHeightLabel?: string | null;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<DragTarget | null>(null);

  function stageCoords(event: ReactPointerEvent): { x: number; y: number } | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    return { x: clamp(x), y: clamp(y) };
  }

  function handlePointerDown(target: DragTarget) {
    return (event: ReactPointerEvent) => {
      event.preventDefault();
      dragging.current = target;
      (event.target as Element).setPointerCapture?.(event.pointerId);
    };
  }

  function handlePointerMove(event: ReactPointerEvent) {
    const target = dragging.current;
    if (!target) return;
    const point = stageCoords(event);
    if (!point) return;
    onChange(moveTarget(blocking, target, point));
  }

  function handlePointerUp(event: ReactPointerEvent) {
    if (!dragging.current) return;
    dragging.current = null;
    (event.target as Element).releasePointerCapture?.(event.pointerId);
    onCommit();
  }

  const [fovLeft, fovRight] = fieldOfViewEdges(blocking.cameraStart);
  const endFov = blocking.cameraEnd ? fieldOfViewEdges(blocking.cameraEnd) : undefined;
  const report = axisReport(blocking);
  const axis = showAxis ? report.axis : undefined;
  const cameraPath = cameraPathPoints(blocking);

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 100 100"
      className="w-full touch-none rounded-md border border-border bg-surface"
      style={{ aspectRatio: "4 / 3" }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <defs>
        <pattern id="stage-grid" width="10" height="10" patternUnits="userSpaceOnUse">
          <path d="M 10 0 L 0 0 0 10" fill="none" stroke="var(--border)" strokeWidth="0.3" />
        </pattern>
        <marker id="stage-arrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
          <path d="M0,0 L5,2.5 L0,5 Z" fill="var(--accent)" />
        </marker>
        <marker id="subject-arrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
          <path d="M0,0 L5,2.5 L0,5 Z" fill="#94a3b8" />
        </marker>
      </defs>

      <rect width="100" height="100" fill="url(#stage-grid)" />

      {/* Field of view at the start, and a ghost of it at the end of the move. */}
      <polygon
        points={`${blocking.cameraStart.x},${blocking.cameraStart.y} ${fovLeft.x},${fovLeft.y} ${fovRight.x},${fovRight.y}`}
        fill="var(--accent)"
        fillOpacity="0.1"
        stroke="var(--accent)"
        strokeOpacity="0.35"
        strokeWidth="0.4"
      />
      {endFov && blocking.cameraEnd && (
        <polygon
          points={`${blocking.cameraEnd.x},${blocking.cameraEnd.y} ${endFov[0].x},${endFov[0].y} ${endFov[1].x},${endFov[1].y}`}
          fill="var(--accent)"
          fillOpacity="0.05"
          stroke="var(--accent)"
          strokeOpacity="0.25"
          strokeWidth="0.35"
          strokeDasharray="1.5 1.5"
        />
      )}

      {/* 180° axis. Extended well past its endpoints because the line is
          conceptually infinite — the two points only establish its direction. */}
      {axis && (
        <>
          <line
            {...extend(axis)}
            stroke={report.crosses ? "#f87171" : "#60a5fa"}
            strokeWidth="0.5"
            strokeDasharray="2 1.5"
          />
          <text
            x={(axis[0].x + axis[1].x) / 2}
            y={(axis[0].y + axis[1].y) / 2 - 1.5}
            textAnchor="middle"
            fontSize="2.8"
            fill={report.crosses ? "#f87171" : "#60a5fa"}
          >
            180° axis
          </text>
        </>
      )}

      {/* Props */}
      {blocking.props.map((prop) => (
        <g key={prop.id} onPointerDown={handlePointerDown({ kind: "prop", id: prop.id })} className="cursor-grab">
          <rect
            x={prop.x - 2}
            y={prop.y - 2}
            width="4"
            height="4"
            rx="0.6"
            fill={prop.layer === "foreground" ? "#a78bfa" : prop.layer === "background" ? "#475569" : "#94a3b8"}
          />
          <text x={prop.x} y={prop.y + 6} textAnchor="middle" fontSize="3" fill="var(--muted)">
            {prop.label}
          </text>
        </g>
      ))}

      {/* Subject paths and figures, one colour each. */}
      {blocking.subjects.map((subject, index) => {
        const colour = subjectColour(index);
        const path = subjectPathPoints(subject);
        return (
          <g key={subject.id}>
            {path.length > 1 && (
              <polyline
                points={polyline(path)}
                fill="none"
                stroke={colour}
                strokeWidth="0.5"
                strokeDasharray="1.5 1"
                markerEnd="url(#subject-arrow)"
              />
            )}

            {subject.waypoints.map((w, i) => (
              <circle
                key={`${subject.id}-wp-${i}`}
                cx={w.x}
                cy={w.y}
                r="1.5"
                fill="var(--surface)"
                stroke={colour}
                strokeWidth="0.5"
                className="cursor-grab"
                onPointerDown={handlePointerDown({ kind: "subjectWaypoint", id: subject.id, index: i })}
              />
            ))}

            <g
              onPointerDown={handlePointerDown({ kind: "subjectStart", id: subject.id })}
              className="cursor-grab"
            >
              <circle cx={subject.start.x} cy={subject.start.y} r="3" fill={colour} />
              <line
                x1={subject.start.x}
                y1={subject.start.y}
                x2={subject.start.x + Math.cos(((subject.start.orientation - 90) * Math.PI) / 180) * 6}
                y2={subject.start.y + Math.sin(((subject.start.orientation - 90) * Math.PI) / 180) * 6}
                stroke={colour}
                strokeWidth="0.7"
              />
              <text x={subject.start.x} y={subject.start.y - 4.5} textAnchor="middle" fontSize="3.2" fill={colour}>
                {subject.label}
              </text>
              {subject.end && (
                <text x={subject.start.x} y={subject.start.y + 6.5} textAnchor="middle" fontSize="2.4" fill={colour}>
                  START
                </text>
              )}
            </g>

            {subject.end && (
              <g
                onPointerDown={handlePointerDown({ kind: "subjectEnd", id: subject.id })}
                className="cursor-grab"
              >
                <circle
                  cx={subject.end.x}
                  cy={subject.end.y}
                  r="3"
                  fill="none"
                  stroke={colour}
                  strokeWidth="0.6"
                  strokeDasharray="1 0.8"
                />
                <line
                  x1={subject.end.x}
                  y1={subject.end.y}
                  x2={subject.end.x + Math.cos(((subject.end.orientation - 90) * Math.PI) / 180) * 5}
                  y2={subject.end.y + Math.sin(((subject.end.orientation - 90) * Math.PI) / 180) * 5}
                  stroke={colour}
                  strokeWidth="0.5"
                  strokeDasharray="1 0.8"
                />
                <text x={subject.end.x} y={subject.end.y + 6.5} textAnchor="middle" fontSize="2.4" fill={colour}>
                  END
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* Camera path — a polyline through its waypoints, not a straight guess. */}
      {cameraPath.length > 1 && (
        <polyline
          points={polyline(cameraPath)}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="0.6"
          markerEnd="url(#stage-arrow)"
        />
      )}

      {blocking.cameraWaypoints.map((w, i) => (
        <g
          key={`cam-wp-${i}`}
          onPointerDown={handlePointerDown({ kind: "cameraWaypoint", index: i })}
          className="cursor-grab"
        >
          <circle cx={w.x} cy={w.y} r="1.8" fill="var(--surface)" stroke="var(--accent)" strokeWidth="0.5" />
          <text x={w.x} y={w.y + 4.2} textAnchor="middle" fontSize="2.2" fill="var(--accent)">
            {i + 1}
          </text>
        </g>
      ))}

      {blocking.cameraEnd && (
        <g onPointerDown={handlePointerDown({ kind: "cameraEnd" })} className="cursor-grab">
          <rect
            x={blocking.cameraEnd.x - 2.5}
            y={blocking.cameraEnd.y - 2.5}
            width="5"
            height="5"
            rx="0.8"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="0.6"
            strokeDasharray="1 0.8"
          />
          <text x={blocking.cameraEnd.x} y={blocking.cameraEnd.y + 7} textAnchor="middle" fontSize="2.4" fill="var(--accent)">
            CAM END
          </text>
        </g>
      )}

      <g onPointerDown={handlePointerDown({ kind: "cameraStart" })} className="cursor-grab">
        <rect
          x={blocking.cameraStart.x - 2.5}
          y={blocking.cameraStart.y - 2.5}
          width="5"
          height="5"
          rx="0.8"
          fill="var(--accent)"
        />
        <text x={blocking.cameraStart.x} y={blocking.cameraStart.y + 7} textAnchor="middle" fontSize="3" fill="var(--accent)">
          {blocking.cameraEnd ? "CAM START" : "CAM"}
        </text>
        {cameraHeightLabel && (
          <text x={blocking.cameraStart.x} y={blocking.cameraStart.y + 10.5} textAnchor="middle" fontSize="2.4" fill="var(--muted)">
            {cameraHeightLabel}
          </text>
        )}
      </g>
    </svg>
  );
}

/** Stretches the axis across the stage: the line is conceptually infinite. */
function extend([a, b]: [Point, Point]) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const k = 200 / len;
  return {
    x1: a.x - (dx * k) / 2,
    y1: a.y - (dy * k) / 2,
    x2: b.x + (dx * k) / 2,
    y2: b.y + (dy * k) / 2,
  };
}

export { axisSide };

function clamp(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

function moveTarget(blocking: ShotBlocking, target: DragTarget, point: { x: number; y: number }): ShotBlocking {
  switch (target.kind) {
    case "cameraStart":
      return { ...blocking, cameraStart: { ...blocking.cameraStart, ...point } };
    case "cameraEnd":
      return blocking.cameraEnd
        ? { ...blocking, cameraEnd: { ...blocking.cameraEnd, ...point } }
        : blocking;
    case "cameraWaypoint":
      return {
        ...blocking,
        cameraWaypoints: blocking.cameraWaypoints.map((w, i) => (i === target.index ? point : w)),
      };
    case "subjectStart":
      return {
        ...blocking,
        subjects: blocking.subjects.map((s) =>
          s.id === target.id ? { ...s, start: { ...s.start, ...point } } : s
        ),
      };
    case "subjectEnd":
      return {
        ...blocking,
        subjects: blocking.subjects.map((s) =>
          s.id === target.id && s.end ? { ...s, end: { ...s.end, ...point } } : s
        ),
      };
    case "subjectWaypoint":
      return {
        ...blocking,
        subjects: blocking.subjects.map((s) =>
          s.id === target.id
            ? { ...s, waypoints: s.waypoints.map((w, i) => (i === target.index ? point : w)) }
            : s
        ),
      };
    case "prop":
      return {
        ...blocking,
        props: blocking.props.map((p) => (p.id === target.id ? { ...p, ...point } : p)),
      };
  }
}
