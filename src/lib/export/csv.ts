import type { ExportPackage } from "./types.ts";

/**
 * CSV shot breakdown — the production document a crew actually passes around.
 *
 * One row per shot, RFC 4180 quoting so a field containing a comma, a quote or a
 * newline survives a round trip into a spreadsheet.
 */
const COLUMNS = [
  "Scene",
  "Slugline",
  "Shot",
  "Shot type",
  "Description",
  "Characters",
  "Location",
  "Time of day",
  "Camera angle",
  "Camera height",
  "Lens",
  "Focal length",
  "Camera movement",
  "Movement speed",
  "Composition",
  "Initial framing",
  "Final framing",
  "Subject movement",
  "Environmental movement",
  "Wardrobe",
  "Hair & makeup",
  "Props carried",
  "Lighting",
  "Mood",
  "Duration (s)",
  "Transition",
  "Blocked",
  "Generations",
  "Completed assets",
] as const;

export function exportCsv(pkg: ExportPackage): string {
  const rows: string[][] = [[...COLUMNS]];

  for (const scene of pkg.scenes) {
    for (const shot of scene.shots) {
      const d = shot.structuredData;
      rows.push([
        scene.number,
        scene.slugline,
        shot.shotNumber,
        str(d.shotType),
        str(d.description),
        scene.characters.join("; "),
        scene.location,
        scene.timeOfDay,
        str(d.cameraAngle),
        str(d.cameraHeight),
        str(d.lens),
        str(d.focalLength),
        str(d.cameraMovement),
        str(d.movementSpeed),
        str(d.composition),
        str(d.initialFraming),
        str(d.finalFraming),
        str(d.subjectMovement),
        str(d.environmentalMovement),
        str(d.wardrobe),
        str(d.hairMakeup),
        str(d.characterProps),
        str(d.lightingNotes),
        str(d.mood),
        str(d.durationSeconds),
        str(d.transition),
        shot.blocking ? "yes" : "no",
        String(shot.generations.length),
        String(shot.generations.filter((g) => g.status === "COMPLETED").length),
      ]);
    }
  }

  return rows.map((row) => row.map(quote).join(",")).join("\r\n");
}

/** Blank means not stated. An empty cell says that better than the word "null". */
function str(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function quote(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}
