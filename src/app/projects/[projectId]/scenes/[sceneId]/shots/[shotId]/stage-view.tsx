"use client";

import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  axisLine,
  crossesAxis,
  fieldOfViewEdges,
  type ShotBlocking,
} from "@/lib/blocking";

type DragTarget =
  | { kind: "cameraStart" }
  | { kind: "cameraEnd" }
  | { kind: "subjectStart"; id: string }
  | { kind: "subjectEnd"; id: string }
  | { kind: "prop"; id: string };

/**
 * Top-down blocking diagram. Drag is one way to edit; every value it changes is
 * also editable as a number in the property panel beside it, so precise work
 * never depends on dragging accurately.
 */
export function StageView({
  blocking,
  onChange,
  onCommit,
  showAxis,
}: {
  blocking: ShotBlocking;
  onChange: (next: ShotBlocking) => void;
  onCommit: () => void;
  showAxis: boolean;
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
  const axis = showAxis ? axisLine(blocking) : undefined;
  const axisCrossed = crossesAxis(blocking);

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
      </defs>

      <rect width="100" height="100" fill="url(#stage-grid)" />

      {/* Field of view */}
      <polygon
        points={`${blocking.cameraStart.x},${blocking.cameraStart.y} ${fovLeft.x},${fovLeft.y} ${fovRight.x},${fovRight.y}`}
        fill="var(--accent)"
        fillOpacity="0.1"
        stroke="var(--accent)"
        strokeOpacity="0.35"
        strokeWidth="0.4"
      />

      {/* 180-degree axis */}
      {axis && (
        <line
          x1={axis[0].x}
          y1={axis[0].y}
          x2={axis[1].x}
          y2={axis[1].y}
          stroke={axisCrossed ? "#f87171" : "#60a5fa"}
          strokeWidth="0.5"
          strokeDasharray="2 1.5"
        />
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

      {/* Subject movement path */}
      {blocking.subjects.map((subject) =>
        subject.end ? (
          <line
            key={`${subject.id}-path`}
            x1={subject.start.x}
            y1={subject.start.y}
            x2={subject.end.x}
            y2={subject.end.y}
            stroke="var(--accent)"
            strokeWidth="0.5"
            strokeDasharray="1.5 1"
            markerEnd="url(#stage-arrow)"
          />
        ) : null
      )}

      {/* Subjects */}
      {blocking.subjects.map((subject) => (
        <g key={subject.id}>
          <g
            onPointerDown={handlePointerDown({ kind: "subjectStart", id: subject.id })}
            className="cursor-grab"
          >
            <circle cx={subject.start.x} cy={subject.start.y} r="3" fill="#34d399" />
            <line
              x1={subject.start.x}
              y1={subject.start.y}
              x2={subject.start.x + Math.cos(((subject.start.orientation - 90) * Math.PI) / 180) * 6}
              y2={subject.start.y + Math.sin(((subject.start.orientation - 90) * Math.PI) / 180) * 6}
              stroke="#34d399"
              strokeWidth="0.7"
            />
            <text x={subject.start.x} y={subject.start.y - 4.5} textAnchor="middle" fontSize="3.2" fill="#34d399">
              {subject.label}
            </text>
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
                stroke="#34d399"
                strokeWidth="0.6"
                strokeDasharray="1 0.8"
              />
            </g>
          )}
        </g>
      ))}

      {/* Camera movement path */}
      {blocking.cameraEnd && (
        <line
          x1={blocking.cameraStart.x}
          y1={blocking.cameraStart.y}
          x2={blocking.cameraEnd.x}
          y2={blocking.cameraEnd.y}
          stroke="var(--accent)"
          strokeWidth="0.6"
          markerEnd="url(#stage-arrow)"
        />
      )}

      {/* Camera end ghost */}
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
        </g>
      )}

      {/* Camera */}
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
          CAM
        </text>
      </g>
    </svg>
  );
}

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
    case "prop":
      return {
        ...blocking,
        props: blocking.props.map((p) => (p.id === target.id ? { ...p, ...point } : p)),
      };
  }
}
