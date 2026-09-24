"use client";

import { useEffect, useRef } from "react";
import { recordAssetMediaInfoAction } from "@/lib/actions/timeline";

/**
 * The sound half of the previz player.
 *
 * One `<audio>` element per placement, kept mounted and steered by the playhead,
 * rather than elements created and destroyed as clips come and go — a browser
 * needs time to fetch and decode, and an element built at the moment a sound
 * should start is an element that starts late.
 *
 * A picture clip's own sound gets its own element here even though the video it
 * comes from is already on screen. That is the whole point of a J- or L-cut: the
 * sound is deliberately not where the picture is, so it cannot be played by the
 * element showing the picture. The video element stays muted and sound is
 * positioned separately, which is also what makes a per-clip mute possible
 * without touching the picture.
 */

export interface Sound {
  /** Stable across renders: the element is reused, not rebuilt. */
  key: string;
  assetId: string;
  /** Where in the file it should be, or null when it should not be sounding. */
  sourceSeconds: number | null;
  /** Linear, already clamped to what an element can actually apply. */
  volume: number;
  /** For reporting a measured length back, so the ruler can use it. */
  measured: boolean;
}

export function AudioEngine({
  projectId,
  sounds,
  playing,
}: {
  projectId: string;
  sounds: Sound[];
  playing: boolean;
}) {
  return (
    <>
      {sounds.map((sound) => (
        <SoundElement key={sound.key} projectId={projectId} sound={sound} playing={playing} />
      ))}
    </>
  );
}

function SoundElement({
  projectId,
  sound,
  playing,
}: {
  projectId: string;
  sound: Sound;
  playing: boolean;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const active = sound.sourceSeconds !== null;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (!active) {
      // Silenced as well as paused: a pause that lands mid-buffer can still
      // leak a fraction of a second when the element is resumed elsewhere.
      el.volume = 0;
      if (!el.paused) el.pause();
      return;
    }

    el.volume = Math.max(0, Math.min(1, sound.volume));

    const target = sound.sourceSeconds ?? 0;
    // Left alone within a third of a second so ordinary playback is not
    // re-seeked on every tick, which would stutter.
    if (Number.isFinite(target) && Math.abs(el.currentTime - target) > 0.35) {
      try {
        el.currentTime = target;
      } catch {
        // metadata not ready yet; the next tick will try again
      }
    }

    // A rejected play() is normal here: browsers refuse audio that did not come
    // from a gesture, and the play button supplies one on the next attempt.
    if (playing) void el.play().catch(() => {});
    else if (!el.paused) el.pause();
  }, [active, sound.sourceSeconds, sound.volume, playing]);

  return (
    <audio
      ref={ref}
      src={`/api/assets/${sound.assetId}/file`}
      preload="metadata"
      onLoadedMetadata={(e) => {
        // Measured by the browser, not guessed from the container — the same
        // rule the video player follows, and the reason an unmeasured
        // placement stops being unmeasured after it has been played once.
        const el = e.currentTarget;
        if (sound.measured) return;
        if (!Number.isFinite(el.duration) || el.duration <= 0) return;
        void recordAssetMediaInfoAction(projectId, sound.assetId, {
          durationSeconds: el.duration,
        });
      }}
    />
  );
}
