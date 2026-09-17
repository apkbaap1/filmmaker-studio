"use client";

import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { ShotBlocking } from "@/lib/blocking";

export interface OverlayToggles {
  thirds: boolean;
  centre: boolean;
  eyeline: boolean;
  headroom: boolean;
  safeArea: boolean;
  leadingLines: boolean;
}

export const DEFAULT_OVERLAYS: OverlayToggles = {
  thirds: true,
  centre: false,
  eyeline: true,
  headroom: false,
  safeArea: false,
  leadingLines: false,
};

const W = 160;
const H = 90;

/**
 * The 16:9 frame. Dragging the subject sets its placement in frame; overlays are
 * viewing guides only. Nothing here writes the shot's `composition` text — a
 * derived description is not a stated compositional intent, so promoting a
 * placement into words is an explicit action in the panel beside this.
 */
export function FrameView({
  blocking,
  subjectLabel,
  overlays,
  onChange,
  onCommit,
}: {
  blocking: ShotBlocking;
  subjectLabel: string;
  overlays: OverlayToggles;
  onChange: (next: ShotBlocking) => void;
  onCommit: () => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<"subject" | "eyeline" | null>(null);

  function handleMove(event: ReactPointerEvent) {
    const mode = dragging.current;
    const svg = svgRef.current;
    if (!mode || !svg) return;
    const rect = svg.getBoundingClientRect();
    const x = clamp(((event.clientX - rect.left) / rect.width) * 100);
    const y = clamp(((event.clientY - rect.top) / rect.height) * 100);

    onChange(
      mode === "subject"
        ? { ...blocking, frame: { ...blocking.frame, subjectX: x, subjectY: y } }
        : { ...blocking, frame: { ...blocking.frame, eyelineY: y } }
    );
  }

  function endDrag(event: ReactPointerEvent) {
    if (!dragging.current) return;
    dragging.current = null;
    (event.target as Element).releasePointerCapture?.(event.pointerId);
    onCommit();
  }

  const f = blocking.frame;
  const cx = (f.subjectX / 100) * W;
  const cy = (f.subjectY / 100) * H;
  const subjectH = (f.subjectScale / 100) * H;
  const subjectW = subjectH * 0.55;
  const eyelineY = (f.eyelineY / 100) * H;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full touch-none rounded-md border border-border bg-black"
      onPointerMove={handleMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Subject */}
      <g
        onPointerDown={(e) => {
          e.preventDefault();
          dragging.current = "subject";
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        className="cursor-grab"
      >
        <rect
          x={cx - subjectW / 2}
          y={cy - subjectH / 2}
          width={subjectW}
          height={subjectH}
          rx="2"
          fill="#34d399"
          fillOpacity="0.25"
          stroke="#34d399"
          strokeWidth="0.6"
        />
        <circle cx={cx} cy={cy - subjectH / 2 + subjectH * 0.18} r={subjectH * 0.13} fill="#34d399" fillOpacity="0.6" />
        <text x={cx} y={cy + subjectH / 2 + 5} textAnchor="middle" fontSize="4" fill="#34d399">
          {subjectLabel}
        </text>
      </g>

      {overlays.thirds && (
        <g stroke="#ffffff" strokeOpacity="0.35" strokeWidth="0.4">
          <line x1={W / 3} y1="0" x2={W / 3} y2={H} />
          <line x1={(2 * W) / 3} y1="0" x2={(2 * W) / 3} y2={H} />
          <line x1="0" y1={H / 3} x2={W} y2={H / 3} />
          <line x1="0" y1={(2 * H) / 3} x2={W} y2={(2 * H) / 3} />
        </g>
      )}

      {overlays.centre && (
        <g stroke="#f5a623" strokeOpacity="0.6" strokeWidth="0.4" strokeDasharray="2 2">
          <line x1={W / 2} y1="0" x2={W / 2} y2={H} />
          <line x1="0" y1={H / 2} x2={W} y2={H / 2} />
        </g>
      )}

      {overlays.safeArea && (
        <rect
          x={W * 0.05}
          y={H * 0.05}
          width={W * 0.9}
          height={H * 0.9}
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.45"
          strokeWidth="0.4"
          strokeDasharray="3 2"
        />
      )}

      {overlays.headroom && (
        <g>
          <line x1="0" y1={H * 0.12} x2={W} y2={H * 0.12} stroke="#60a5fa" strokeOpacity="0.7" strokeWidth="0.4" />
          <text x="2" y={H * 0.12 - 1.5} fontSize="3.5" fill="#60a5fa">
            headroom
          </text>
        </g>
      )}

      {overlays.eyeline && (
        <g
          onPointerDown={(e) => {
            e.preventDefault();
            dragging.current = "eyeline";
            (e.target as Element).setPointerCapture?.(e.pointerId);
          }}
          className="cursor-ns-resize"
        >
          <line x1="0" y1={eyelineY} x2={W} y2={eyelineY} stroke="#fbbf24" strokeOpacity="0.85" strokeWidth="0.5" />
          <rect x="0" y={eyelineY - 2} width={W} height="4" fill="transparent" />
          <text x={W - 2} y={eyelineY - 1.5} textAnchor="end" fontSize="3.5" fill="#fbbf24">
            eyeline
          </text>
        </g>
      )}

      {overlays.leadingLines && (
        <g stroke="#c084fc" strokeOpacity="0.5" strokeWidth="0.4" strokeDasharray="2 2">
          <line x1="0" y1={H} x2={cx} y2={cy} />
          <line x1={W} y1={H} x2={cx} y2={cy} />
        </g>
      )}

      <rect x="0" y="0" width={W} height={H} fill="none" stroke="var(--border)" strokeWidth="0.8" />
    </svg>
  );
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}
