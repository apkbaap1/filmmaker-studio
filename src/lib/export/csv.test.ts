import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { exportCsv } from "./csv.ts";
import type { ExportPackage } from "./types.ts";

function pkg(overrides: Partial<ExportPackage> = {}): ExportPackage {
  return {
    formatVersion: 1,
    generatedAt: "2026-09-18T00:00:00.000Z",
    providerTransparency: {
      imageProvider: { id: "openai-gpt-image-1", label: "OpenAI", model: "gpt-image-1", configured: false },
      videoProvider: null,
      note: "No providers configured.",
    },
    project: { id: "p", title: "Ravi", logline: null, genre: null, format: null, status: "Development" },
    scenes: [
      {
        id: "s4",
        number: "4",
        slugline: "INT. ABANDONED RAILWAY STATION — NIGHT",
        intExt: "INT",
        location: "ABANDONED RAILWAY STATION",
        timeOfDay: "NIGHT",
        synopsis: null,
        characters: ["Ravi", "Guard"],
        shots: [
          {
            id: "shot-12",
            shotNumber: "12",
            structuredData: {
              shotType: "Medium Close-Up",
              description: 'He says "wait", then turns',
              focalLength: "85mm",
              lens: "Prime",
              durationSeconds: 6,
              lightingNotes: "Warm practical,\ncool moonlight",
              wardrobe: null,
            },
            blocking: { version: 2 },
            prompts: { spec: {}, image: {}, video: {}, imageToVideo: {} },
            promptVersions: [],
            generations: [
              { id: "g1", mode: "IMAGE", source: "STRUCTURED", status: "COMPLETED", promptUsed: "x",
                promptEdited: false, providerId: "openai", promptProviderId: "generic",
                durationSeconds: null, error: null, assetId: "a1", sourceAssetId: null,
                createdAt: "2026-09-18T00:00:00.000Z" },
              { id: "g2", mode: "VIDEO", source: "STRUCTURED", status: "FAILED", promptUsed: "y",
                promptEdited: false, providerId: "local-stub", promptProviderId: "generic",
                durationSeconds: 6, error: "nope", assetId: null, sourceAssetId: null,
                createdAt: "2026-09-18T00:00:00.000Z" },
            ],
            storyboardAssetId: "a1",
            assets: [],
          },
        ],
      },
    ],
    continuity: [],
    ...overrides,
  };
}

/** Minimal RFC 4180 reader, so the tests parse the CSV rather than trusting it. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\r" && text[i + 1] === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; }
    else field += char;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

describe("CSV shot breakdown", () => {
  it("is valid CSV with a header and one row per shot", () => {
    const rows = parseCsv(exportCsv(pkg()));
    assert.equal(rows.length, 2);
    assert.equal(rows[0][0], "Scene");
    assert.equal(rows[0].length, rows[1].length, "every row has the header's column count");
  });

  it("round-trips a field containing a comma, a quote and a newline", () => {
    const rows = parseCsv(exportCsv(pkg()));
    const header = rows[0];
    const row = rows[1];
    assert.equal(row[header.indexOf("Description")], 'He says "wait", then turns');
    assert.equal(row[header.indexOf("Lighting")], "Warm practical,\ncool moonlight");
  });

  it("writes an empty cell for a value that was never stated", () => {
    const rows = parseCsv(exportCsv(pkg()));
    const header = rows[0];
    assert.equal(rows[1][header.indexOf("Wardrobe")], "", "never the word null");
  });

  it("carries the production values a crew actually needs", () => {
    const rows = parseCsv(exportCsv(pkg()));
    const header = rows[0];
    const row = rows[1];
    assert.equal(row[header.indexOf("Scene")], "4");
    assert.equal(row[header.indexOf("Shot")], "12");
    assert.equal(row[header.indexOf("Shot type")], "Medium Close-Up");
    assert.equal(row[header.indexOf("Focal length")], "85mm");
    assert.equal(row[header.indexOf("Characters")], "Ravi; Guard");
    assert.equal(row[header.indexOf("Duration (s)")], "6");
    assert.equal(row[header.indexOf("Blocked")], "yes");
    assert.equal(row[header.indexOf("Generations")], "2");
    assert.equal(row[header.indexOf("Completed assets")], "1");
  });

  it("produces only a header for a project with no shots", () => {
    const rows = parseCsv(exportCsv(pkg({ scenes: [] })));
    assert.equal(rows.length, 1);
  });
});
