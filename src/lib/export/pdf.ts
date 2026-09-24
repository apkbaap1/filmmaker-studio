import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { ExportPackage } from "./types.ts";

/**
 * The human-readable production report.
 *
 * A document a filmmaker can hand to a crew: sections, headings and prose, with
 * the structured record left to the JSON package. Deliberately no raw database
 * dump — a value that was never stated is simply left out rather than printed as
 * "null".
 */

const PAGE = { width: 595.28, height: 841.89 }; // A4 portrait, points
const MARGIN = 48;
const INK = rgb(0.13, 0.14, 0.17);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.86, 0.88);
const WARN = rgb(0.72, 0.22, 0.22);

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  regular: PDFFont;
  bold: PDFFont;
  pageNumber: number;
}

export async function exportPdf(pkg: ExportPackage): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${pkg.project.title} — production report`);
  doc.setProducer("Filmmaker Studio");
  doc.setCreationDate(new Date(pkg.generatedAt));

  const ctx: Ctx = {
    doc,
    page: doc.addPage([PAGE.width, PAGE.height]),
    y: PAGE.height - MARGIN,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    pageNumber: 1,
  };

  // 1. Project
  title(ctx, pkg.project.title);
  muted(ctx, `Production report · generated ${new Date(pkg.generatedAt).toLocaleString()}`);
  gap(ctx, 6);
  for (const [label, value] of [
    ["Status", pkg.project.status],
    ["Genre", pkg.project.genre],
    ["Format", pkg.project.format],
    ["Logline", pkg.project.logline],
  ] as Array<[string, string | null]>) {
    if (value) field(ctx, label, value);
  }

  gap(ctx, 8);
  heading(ctx, "AI provider status");
  // Carried into the document itself so a printed report cannot misrepresent
  // what produced the media.
  body(ctx, pkg.providerTransparency.note, pkg.providerTransparency.videoProvider?.isStub ? WARN : MUTED);

  // 2-3. Scene and shot breakdown
  const totalShots = pkg.scenes.reduce((n, s) => n + s.shots.length, 0);
  section(ctx, "Scene breakdown");
  muted(ctx, `${pkg.scenes.length} scene${pkg.scenes.length === 1 ? "" : "s"}, ${totalShots} shot${totalShots === 1 ? "" : "s"}`);

  for (const scene of pkg.scenes) {
    gap(ctx, 10);
    heading(ctx, `Scene ${scene.number} — ${scene.slugline}`);
    if (scene.characters.length > 0) field(ctx, "Characters", scene.characters.join(", "));
    if (scene.synopsis) body(ctx, scene.synopsis);

    for (const shot of scene.shots) {
      gap(ctx, 8);
      subheading(ctx, `Shot ${shot.shotNumber} — ${shot.structuredData.shotType ?? "Shot"}`);
      const d = shot.structuredData;

      if (d.description) body(ctx, String(d.description));

      // 5. Camera & lens
      line(ctx, "Camera", [d.cameraAngle, d.cameraHeight, joinLens(d.focalLength, d.lens)]);
      // 8. Movement
      line(ctx, "Movement", [d.cameraMovement, d.movementSpeed, d.subjectMovement, d.environmentalMovement]);
      line(ctx, "Framing", [d.composition, d.initialFraming && `from ${d.initialFraming}`, d.finalFraming && `to ${d.finalFraming}`]);
      // 7. Lighting
      line(ctx, "Lighting", [d.lightingNotes, d.mood]);
      line(ctx, "Continuity", [d.wardrobe, d.hairMakeup, d.characterProps]);
      line(ctx, "Timing", [d.durationSeconds && `${d.durationSeconds}s`, d.transition, d.editPoint]);
      // 6. Blocking
      if (shot.blocking) field(ctx, "Blocking", blockingSummary(shot.blocking));
      // 4. Storyboard
      // A crew document has no use for a database id; the JSON package carries
      // the reference for machines.
      if (shot.storyboardAssetId) field(ctx, "Storyboard", "frame available");
      if (d.directorNotes) field(ctx, "Director's note", String(d.directorNotes));

      // 12. Generated assets
      if (shot.generations.length > 0) {
        const done = shot.generations.filter((g) => g.status === "COMPLETED").length;
        field(ctx, "Generations", `${shot.generations.length} attempt${shot.generations.length === 1 ? "" : "s"}, ${done} completed`);
      }

      // 11. AI prompts — the generic rendering; per-provider text lives in JSON.
      if (shot.prompts.image.generic) {
        gap(ctx, 3);
        promptBlock(ctx, "Image prompt", shot.prompts.image.generic);
      }
      if (shot.prompts.video.generic) promptBlock(ctx, "Video prompt", shot.prompts.video.generic);
    }
  }

  // 9. Timeline
  if (pkg.timeline) {
    section(ctx, "Timeline");
    muted(
      ctx,
      `${pkg.timeline.sequenceName} · ${pkg.timeline.clips.length} clips · ${pkg.timeline.totalSeconds}s total` +
        (pkg.timeline.overlapSeconds > 0
          ? ` (${pkg.timeline.overlapSeconds}s of dissolves; ${pkg.timeline.straightCutSeconds}s on straight cuts)`
          : "")
    );
    gap(ctx, 4);
    for (const clip of pkg.timeline.clips) {
      const trim =
        clip.outPointSeconds === null && clip.inPointSeconds === 0
          ? "whole shot"
          : `in ${clip.inPointSeconds}s, out ${clip.outPointSeconds ?? "end"}`;
      body(
        ctx,
        `Shot ${clip.shotNumber} · ${clip.startSeconds}s–${clip.endSeconds}s (${clip.usedSeconds}s used, ${trim})` +
          (clip.transition ? ` · ${clip.transition.toLowerCase().replace(/_/g, " ")}` : "") +
          // The length it actually ran, not the length asked for: a dissolve
          // limited by the material on either side plays shorter, and a report
          // quoting the stated figure would describe an edit that is not there.
          (clip.transitionEffectiveSeconds ? ` ${clip.transitionEffectiveSeconds}s` : "") +
          (clip.overlapSeconds > 0 ? ` (overlaps −${clip.overlapSeconds}s)` : "") +
          // Only worth a line when the sound is not simply under its own
          // picture: a J- or L-cut, or a clip this edit plays silent.
          (clip.audioMuted
            ? " · sound muted"
            : clip.audio?.offsetFromPicture
              ? ` · sound ${clip.audio.startSeconds}s–${clip.audio.endSeconds}s`
              : "")
      );
    }

    if (pkg.timeline.audioTracks.length > 0) {
      gap(ctx, 4);
      muted(
        ctx,
        `Sound runs to ${pkg.timeline.runtime.audioSeconds}s; the cut runs to ${pkg.timeline.runtime.pictureSeconds}s`
      );
      for (const track of pkg.timeline.audioTracks) {
        body(
          ctx,
          `${track.name} (${track.role.toLowerCase()})` +
            (track.muted ? " · MUTED" : "") +
            // Null gain is unity — no level stated — so it prints nothing
            // rather than "0 dB", which would be a level someone chose.
            (track.gainDb === null ? "" : ` · ${track.gainDb > 0 ? "+" : ""}${track.gainDb} dB`) +
            ` · ${track.clips.length} placements`
        );
        for (const clip of track.clips) {
          body(
            ctx,
            `    ${clip.caption ?? clip.assetId} · ${clip.startSeconds}s–` +
              (clip.endSeconds === null ? "? (length not measured)" : `${clip.endSeconds}s`) +
              (clip.gainDb === null ? "" : ` · ${clip.gainDb > 0 ? "+" : ""}${clip.gainDb} dB`) +
              (clip.fadeInSeconds ? ` · fade in ${clip.fadeInSeconds}s` : "") +
              (clip.fadeOutSeconds ? ` · fade out ${clip.fadeOutSeconds}s` : "")
          );
        }
      }
    }
  }

  // 10. Continuity notes
  section(ctx, "Continuity notes");
  if (pkg.continuity.length === 0) {
    muted(ctx, "No differences worth reporting between related shots.");
  } else {
    for (const finding of pkg.continuity) {
      gap(ctx, 5);
      subheading(
        ctx,
        `${finding.severity.replace(/_/g, " ")} — ${finding.category.replace(/_/g, " ")}` +
          (finding.subject ? ` (${finding.subject})` : "")
      );
      muted(ctx, `Shot ${finding.shotA} → Shot ${finding.shotB}${finding.decision ? ` · marked ${finding.decision.toLowerCase()}` : ""}`);
      body(ctx, finding.whatChanged);
      body(ctx, finding.whyItMayMatter, MUTED);
    }
  }

  stampPageNumbers(ctx);
  return doc.save();
}

// --- layout primitives -------------------------------------------------------

function ensureRoom(ctx: Ctx, needed: number) {
  if (ctx.y - needed >= MARGIN + 24) return;
  ctx.page = ctx.doc.addPage([PAGE.width, PAGE.height]);
  ctx.y = PAGE.height - MARGIN;
  ctx.pageNumber += 1;
}

function draw(ctx: Ctx, text: string, size: number, font: PDFFont, colour = INK, indent = 0) {
  const maxWidth = PAGE.width - MARGIN * 2 - indent;
  for (const lineText of wrap(text, font, size, maxWidth)) {
    ensureRoom(ctx, size + 4);
    ctx.page.drawText(lineText, { x: MARGIN + indent, y: ctx.y - size, size, font, color: colour });
    ctx.y -= size + 3;
  }
}

function title(ctx: Ctx, text: string) {
  draw(ctx, text, 20, ctx.bold);
  ctx.y -= 2;
}

function section(ctx: Ctx, text: string) {
  gap(ctx, 14);
  ensureRoom(ctx, 28);
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y + 4 },
    end: { x: PAGE.width - MARGIN, y: ctx.y + 4 },
    thickness: 0.7,
    color: RULE,
  });
  ctx.y -= 6;
  draw(ctx, text.toUpperCase(), 12, ctx.bold);
  ctx.y -= 2;
}

function heading(ctx: Ctx, text: string) {
  draw(ctx, text, 11, ctx.bold);
}

function subheading(ctx: Ctx, text: string) {
  draw(ctx, text, 10, ctx.bold, INK, 10);
}

function body(ctx: Ctx, text: string, colour = INK) {
  draw(ctx, text, 9, ctx.regular, colour, 10);
}

function muted(ctx: Ctx, text: string) {
  draw(ctx, text, 8.5, ctx.regular, MUTED);
}

function field(ctx: Ctx, label: string, value: string) {
  draw(ctx, `${label}: ${value}`, 9, ctx.regular, INK, 10);
}

/** Prints a labelled line only if at least one of its parts was stated. */
function line(ctx: Ctx, label: string, parts: Array<string | number | null | undefined | false>) {
  const kept = parts.filter((p): p is string | number => p !== null && p !== undefined && p !== false && p !== "");
  if (kept.length === 0) return;
  field(ctx, label, kept.join(" · "));
}

function promptBlock(ctx: Ctx, label: string, text: string) {
  draw(ctx, label, 8.5, ctx.bold, MUTED, 10);
  draw(ctx, text, 8.5, ctx.regular, MUTED, 18);
  ctx.y -= 2;
}

function gap(ctx: Ctx, amount: number) {
  ctx.y -= amount;
}

function joinLens(focal: unknown, lens: unknown): string | null {
  const parts = [focal, lens].filter((p): p is string => typeof p === "string" && p !== "");
  return parts.length ? parts.join(" ") : null;
}

function blockingSummary(blocking: unknown): string {
  const b = blocking as {
    subjects?: Array<{ label: string; end?: unknown }>;
    props?: Array<{ label: string }>;
    cameraEnd?: unknown;
    cameraWaypoints?: unknown[];
    axis?: { mode?: string };
  };
  const parts: string[] = [];
  if (b.subjects?.length) {
    parts.push(
      `${b.subjects.length} subject${b.subjects.length === 1 ? "" : "s"} (${b.subjects.map((s) => s.label).join(", ")})`
    );
  }
  if (b.props?.length) parts.push(`props: ${b.props.map((p) => p.label).join(", ")}`);
  parts.push(b.cameraEnd ? "camera moves" : "camera static");
  if (b.cameraWaypoints?.length) parts.push(`${b.cameraWaypoints.length} waypoint(s)`);
  if (b.axis?.mode) parts.push(`axis: ${b.axis.mode.replace(/-/g, " ")}`);
  return parts.join(" · ");
}

function stampPageNumbers(ctx: Ctx) {
  const pages = ctx.doc.getPages();
  pages.forEach((page, index) => {
    page.drawText(`${index + 1} / ${pages.length}`, {
      x: PAGE.width - MARGIN - 40,
      y: MARGIN - 18,
      size: 8,
      font: ctx.regular,
      color: MUTED,
    });
  });
}

/**
 * Wraps to the measured width of the actual font, and breaks a single
 * over-long token rather than letting it run off the page.
 */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of sanitise(text).split("\n")) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) out.push(current);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        current = word;
      } else {
        let chunk = "";
        for (const char of word) {
          if (font.widthOfTextAtSize(chunk + char, size) > maxWidth) {
            out.push(chunk);
            chunk = char;
          } else {
            chunk += char;
          }
        }
        current = chunk;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

/**
 * The standard PDF fonts are WinAnsi-encoded, so a character outside that set
 * throws when drawn. Typographic punctuation the app uses freely — em dashes,
 * curly quotes, arrows, the degree sign — is mapped to its nearest printable
 * equivalent rather than being allowed to fail the export.
 */
const REPLACEMENTS: Array<[RegExp, string]> = [
  [/[‘’‛]/g, "'"],
  [/[“”‟]/g, '"'],
  [/—/g, "--"],
  [/–/g, "-"],
  [/…/g, "..."],
  [/→/g, "->"],
  [/°/g, " deg"],
  [/[✓✔]/g, "y"],
  [/[⚠️]/g, "!"],
  [/×/g, "x"],
  [/≈/g, "~"],
  [/ /g, " "],
];

function sanitise(text: string): string {
  let out = text.replace(/\r\n/g, "\n");
  for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement);
  // Anything still outside the printable Latin-1 range becomes a plain space so
  // one stray character can never break a production document.
  return out.replace(/[^\n\x20-\x7E\xA1-\xFF]/g, " ");
}
