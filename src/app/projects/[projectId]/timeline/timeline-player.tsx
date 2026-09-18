"use client";

import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui";
import { formatTimecode } from "@/lib/timeline";
import { recordAssetMediaInfoAction } from "@/lib/actions/timeline";
import type { AssetRef, ShotRef } from "./types";

/**
 * The previz viewport.
 *
 * Shows whatever the current clip actually has: its generated video, otherwise
 * its storyboard frame, otherwise a slate with the shot's own details. A shot
 * with nothing generated is a normal state here, not a gap — the point is to see
 * the scene's progression, and a storyboard frame carries that perfectly well.
 */
export function TimelinePlayer({
  projectId,
  shot,
  asset,
  offsetSeconds,
  inPointSeconds,
  playing,
  playheadSeconds,
  totalSeconds,
}: {
  projectId: string;
  shot: ShotRef | undefined;
  asset: AssetRef | undefined;
  offsetSeconds: number;
  inPointSeconds: number;
  playing: boolean;
  playheadSeconds: number;
  totalSeconds: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const isVideo = Boolean(asset?.mimeType.startsWith("video/"));

  // Keep the element on the frame the playhead is over. Small drifts are left
  // alone so normal playback isn't constantly re-seeked.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isVideo) return;
    const target = inPointSeconds + offsetSeconds;
    if (Number.isFinite(target) && Math.abs(video.currentTime - target) > 0.35) {
      try {
        video.currentTime = target;
      } catch {
        // metadata not ready yet; the next tick will try again
      }
    }
    if (playing) void video.play().catch(() => {});
    else video.pause();
  }, [isVideo, offsetSeconds, inPointSeconds, playing, asset?.id]);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-black">
      <div className="relative flex aspect-video items-center justify-center">
        {asset && isVideo ? (
          <video
            ref={videoRef}
            key={asset.id}
            src={`/api/assets/${asset.id}/file`}
            muted
            playsInline
            className="h-full w-full object-contain"
            onLoadedMetadata={(e) => {
              // The browser has decoded the file, so these are measurements
              // rather than guesses. Recorded once so the ruler can use the
              // clip's real length.
              const el = e.currentTarget;
              if (asset.durationSeconds && asset.width) return;
              if (!Number.isFinite(el.duration) || el.duration <= 0) return;
              void recordAssetMediaInfoAction(projectId, asset.id, {
                durationSeconds: el.duration,
                width: el.videoWidth,
                height: el.videoHeight,
              });
            }}
          />
        ) : asset ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/assets/${asset.id}/file`}
            alt={asset.caption ?? "Storyboard frame"}
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="px-6 text-center">
            <p className="font-mono text-sm text-muted">
              {shot ? `SHOT ${shot.shotNumber}` : "No clip under the playhead"}
            </p>
            {shot && (
              <>
                <p className="mt-1 text-sm text-foreground">{shot.shotType}</p>
                <p className="mt-1 text-xs text-muted">
                  {[shot.cameraAngle, shot.cameraMovement, shot.lens].filter(Boolean).join(" · ") ||
                    "Nothing generated for this shot yet"}
                </p>
              </>
            )}
          </div>
        )}

        <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 font-mono text-xs text-white">
          {formatTimecode(playheadSeconds)} / {formatTimecode(totalSeconds)}
        </div>
        {shot && (
          <div className="pointer-events-none absolute right-2 top-2 flex gap-1">
            <Badge tone="accent">Shot {shot.shotNumber}</Badge>
            {!asset && <Badge>no visual</Badge>}
            {asset && !isVideo && <Badge>storyboard frame</Badge>}
          </div>
        )}
      </div>
    </div>
  );
}
