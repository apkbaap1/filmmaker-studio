import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyseContinuity,
  applyDecisions,
  buildPairs,
  characterTimeline,
  openFindings,
  propTimeline,
  screenDirectionOf,
  trackedCharacters,
  trackedProps,
  type AnalysisInput,
  type ContinuityScene,
  type ContinuityShot,
  type DecisionStatus,
} from "./continuity.ts";
import type { ShotBlocking } from "./blocking.ts";

/**
 * Phase 9 — continuity analysis.
 *
 * Two rules are on trial in nearly every case below: unspecified is never
 * absent, and a difference is never automatically an error.
 */

const STATION: ContinuityScene = {
  id: "scene-4",
  number: "4",
  location: "ABANDONED RAILWAY STATION",
  timeOfDay: "NIGHT",
  intExt: "INT",
};

const STREET: ContinuityScene = {
  id: "scene-5",
  number: "5",
  location: "RAIN-SLICK STREET",
  timeOfDay: "NIGHT",
  intExt: "EXT",
};

function shot(partial: Partial<ContinuityShot> & { id: string; order: number }): ContinuityShot {
  return {
    sceneId: "scene-4",
    shotNumber: partial.id,
    shotType: "Medium Shot",
    ...partial,
  };
}

function blocking(partial: Partial<ShotBlocking> = {}): ShotBlocking {
  return {
    version: 2,
    cameraStart: { x: 50, y: 85, rotation: 0, fov: 70 },
    cameraWaypoints: [],
    subjects: [{ id: "ravi", label: "Ravi", start: { x: 50, y: 45, orientation: 180 }, waypoints: [] }],
    props: [],
    frame: { subjectX: 50, subjectY: 50, subjectScale: 40, eyelineY: 33 },
    ...partial,
  };
}

function analyse(shots: ContinuityShot[], scenes: ContinuityScene[] = [STATION], editOrder?: string[]) {
  const input: AnalysisInput = {
    shots,
    scenes: Object.fromEntries(scenes.map((s) => [s.id, s])),
    editOrder,
  };
  return analyseContinuity(input);
}

const categories = (findings: ReturnType<typeof analyse>) => findings.map((f) => f.category);

// 1-3 --- wardrobe -----------------------------------------------------------

describe("1-3. character wardrobe", () => {
  it("1. says nothing when the wardrobe is the same", () => {
    const findings = analyse([
      shot({ id: "10", order: 0, wardrobe: "Charcoal overcoat" }),
      shot({ id: "11", order: 1, wardrobe: "Charcoal overcoat" }),
    ]);
    assert.deepEqual(findings, []);
  });

  it("1b. ignores casing and spacing rather than reporting a non-change", () => {
    const findings = analyse([
      shot({ id: "10", order: 0, wardrobe: "Charcoal overcoat" }),
      shot({ id: "11", order: 1, wardrobe: "  charcoal   overcoat " }),
    ]);
    assert.deepEqual(findings, []);
  });

  it("2. reports an explicit wardrobe change as a potential issue, not an error", () => {
    const findings = analyse([
      shot({ id: "10", order: 0, wardrobe: "Charcoal overcoat" }),
      shot({ id: "11", order: 1, wardrobe: "White shirt" }),
    ]);
    assert.equal(findings.length, 1);
    const [finding] = findings;
    assert.equal(finding.category, "WARDROBE");
    assert.equal(finding.severity, "POTENTIAL_ISSUE");
    assert.notEqual(finding.severity, "ERROR" as unknown);
    assert.ok(finding.whatChanged.includes("Charcoal overcoat"));
    assert.ok(finding.whatChanged.includes("White shirt"));
    assert.ok(finding.whyItMayMatter.length > 0, "every finding explains why it may matter");
    assert.equal(finding.shotAId, "10");
    assert.equal(finding.shotBId, "11");
  });

  it("3. raises nothing when one side never stated a wardrobe", () => {
    for (const pair of [
      [{ wardrobe: "Charcoal overcoat" }, {}],
      [{}, { wardrobe: "White shirt" }],
      [{ wardrobe: "Charcoal overcoat" }, { wardrobe: "" }],
      [{ wardrobe: null }, { wardrobe: "White shirt" }],
      [{}, {}],
    ] as Array<[Partial<ContinuityShot>, Partial<ContinuityShot>]>) {
      const findings = analyse([
        shot({ id: "10", order: 0, ...pair[0] }),
        shot({ id: "11", order: 1, ...pair[1] }),
      ]);
      assert.deepEqual(findings, [], `unspecified must never be treated as a change: ${JSON.stringify(pair)}`);
    }
  });
});

// 4-5 --- location -----------------------------------------------------------

describe("4-5. location", () => {
  it("4. says nothing about location for two shots in the same scene", () => {
    const findings = analyse([shot({ id: "10", order: 0 }), shot({ id: "11", order: 1 })]);
    assert.ok(!categories(findings).includes("LOCATION"));
  });

  it("5. reports a location change between edit-adjacent shots as information only", () => {
    const findings = analyse(
      [shot({ id: "10", order: 0 }), shot({ id: "20", order: 0, sceneId: "scene-5" })],
      [STATION, STREET],
      ["10", "20"]
    );
    const location = findings.find((f) => f.category === "LOCATION");
    assert.ok(location, "the change is reported");
    assert.equal(location.severity, "INFO", "cutting between locations is not a problem");
    assert.equal(location.relation, "adjacent-in-edit");
  });

  it("flags same location at a different time of day for review", () => {
    const laterScene: ContinuityScene = { ...STREET, id: "scene-6", location: STATION.location, timeOfDay: "DAY" };
    const findings = analyse(
      [shot({ id: "10", order: 0 }), shot({ id: "30", order: 0, sceneId: "scene-6" })],
      [STATION, laterScene],
      ["10", "30"]
    );
    const time = findings.find((f) => f.category === "TIME_OF_DAY");
    assert.ok(time);
    assert.equal(time.severity, "REVIEW");
  });
});

// 6-7 --- props --------------------------------------------------------------

describe("6-7. props", () => {
  const bench = { id: "bench", label: "Platform bench", x: 20, y: 70, layer: "foreground" as const };
  const crate = { id: "crate", label: "Mail crate", x: 70, y: 60, layer: "background" as const };

  it("6. reports a prop placed in one shot and missing from a shot that places others", () => {
    const findings = analyse([
      shot({ id: "10", order: 0, blocking: blocking({ props: [bench, crate] }) }),
      shot({ id: "11", order: 1, blocking: blocking({ props: [crate] }) }),
    ]);
    const prop = findings.find((f) => f.category === "PROP");
    assert.ok(prop);
    assert.equal(prop.subject, "Platform bench");
    assert.equal(prop.severity, "REVIEW");
  });

  it("7. never treats an unspecified prop list as a disappearance", () => {
    // The second shot places no props at all: it has said nothing about props.
    const noProps = analyse([
      shot({ id: "10", order: 0, blocking: blocking({ props: [bench] }) }),
      shot({ id: "11", order: 1, blocking: blocking({ props: [] }) }),
    ]);
    assert.ok(!categories(noProps).includes("PROP"));

    // The second shot has no blocking at all.
    const noBlocking = analyse([
      shot({ id: "10", order: 0, blocking: blocking({ props: [bench] }) }),
      shot({ id: "11", order: 1 }),
    ]);
    assert.ok(!categories(noBlocking).includes("PROP"));
  });

  it("keeps present, absent and unspecified as three different things on the timeline", () => {
    const input: AnalysisInput = {
      shots: [
        shot({ id: "3", order: 0, blocking: blocking({ props: [bench] }) }),
        shot({ id: "4", order: 1, blocking: blocking({ props: [bench, crate] }) }),
        shot({ id: "5", order: 2 }),
        shot({ id: "6", order: 3, blocking: blocking({ props: [crate] }) }),
      ],
      scenes: { "scene-4": STATION },
    };
    assert.deepEqual(
      propTimeline(input, "Platform bench").map((e) => e.presence),
      ["present", "present", "unspecified", "absent"]
    );
  });
});

// 8 --- lighting -------------------------------------------------------------

describe("8. lighting", () => {
  it("says nothing when the lighting matches", () => {
    const findings = analyse([
      shot({ id: "10", order: 0, lightingNotes: "Warm practical + cool moonlight" }),
      shot({ id: "11", order: 1, lightingNotes: "Warm practical + cool moonlight" }),
    ]);
    assert.deepEqual(findings, []);
  });

  it("reports a lighting change inside a scene as a potential issue", () => {
    const findings = analyse([
      shot({ id: "11", order: 0, lightingNotes: "Warm practical + cool moonlight" }),
      shot({ id: "12", order: 1, lightingNotes: "Hard daylight" }),
    ]);
    const lighting = findings.find((f) => f.category === "LIGHTING");
    assert.ok(lighting);
    assert.equal(lighting.severity, "POTENTIAL_ISSUE");
  });

  it("downgrades a lighting change between scenes to information", () => {
    const findings = analyse(
      [
        shot({ id: "10", order: 0, lightingNotes: "Warm practical + cool moonlight" }),
        shot({ id: "20", order: 0, sceneId: "scene-5", lightingNotes: "Hard daylight" }),
      ],
      [STATION, STREET],
      ["10", "20"]
    );
    assert.equal(findings.find((f) => f.category === "LIGHTING")?.severity, "INFO");
  });
});

// 9-11 --- axis and screen direction -----------------------------------------

describe("9-11. axis and screen direction", () => {
  /** Two characters, so the axis runs between them and is easy to cross. */
  const twoHander = (cameraX: number) =>
    blocking({
      cameraStart: { x: cameraX, y: 85, rotation: 0, fov: 70 },
      subjects: [
        { id: "a", label: "Ravi", start: { x: 30, y: 45, orientation: 90 }, waypoints: [] },
        { id: "b", label: "Guard", start: { x: 70, y: 45, orientation: 270 }, waypoints: [] },
      ],
    });

  it("9. reports the camera crossing the established axis between shots", () => {
    const findings = analyse([
      shot({ id: "11", order: 0, blocking: twoHander(50) }),
      shot({
        id: "12",
        order: 1,
        blocking: blocking({
          cameraStart: { x: 50, y: 10, rotation: 180, fov: 70 },
          subjects: twoHander(50).subjects,
        }),
      }),
    ]);
    const axis = findings.find((f) => f.category === "AXIS");
    assert.ok(axis, "crossing the axis between shots is reported");
    assert.equal(axis.severity, "POTENTIAL_ISSUE");
    assert.ok(/intentional/i.test(axis.whyItMayMatter), "and explicitly says it may be deliberate");
  });

  it("9b. says nothing when both cameras stay on the same side", () => {
    const findings = analyse([
      shot({ id: "10", order: 0, blocking: twoHander(40) }),
      shot({ id: "11", order: 1, blocking: twoHander(60) }),
    ]);
    assert.ok(!categories(findings).includes("AXIS"));
  });

  it("10. reports a screen-direction reversal for a character who moves in both shots", () => {
    const leftToRight = blocking({
      subjects: [
        {
          id: "ravi",
          label: "Ravi",
          start: { x: 35, y: 45, orientation: 90 },
          end: { x: 65, y: 45, orientation: 90 },
          waypoints: [],
        },
      ],
    });
    const rightToLeft = blocking({
      subjects: [
        {
          id: "ravi",
          label: "Ravi",
          start: { x: 65, y: 45, orientation: 270 },
          end: { x: 35, y: 45, orientation: 270 },
          waypoints: [],
        },
      ],
    });

    assert.equal(screenDirectionOf(leftToRight, "Ravi"), "left-to-right");
    assert.equal(screenDirectionOf(rightToLeft, "Ravi"), "right-to-left");

    const findings = analyse([
      shot({ id: "11", order: 0, blocking: leftToRight }),
      shot({ id: "12", order: 1, blocking: rightToLeft }),
    ]);
    const direction = findings.find((f) => f.category === "SCREEN_DIRECTION");
    assert.ok(direction);
    assert.equal(direction.subject, "Ravi");
    assert.equal(direction.severity, "POTENTIAL_ISSUE");
  });

  it("11. says nothing when screen direction holds", () => {
    const leftToRight = blocking({
      subjects: [
        {
          id: "ravi",
          label: "Ravi",
          start: { x: 35, y: 45, orientation: 90 },
          end: { x: 60, y: 45, orientation: 90 },
          waypoints: [],
        },
      ],
    });
    const findings = analyse([
      shot({ id: "10", order: 0, blocking: leftToRight }),
      shot({ id: "11", order: 1, blocking: leftToRight }),
    ]);
    assert.ok(!categories(findings).includes("SCREEN_DIRECTION"));
  });

  it("11b. has no screen direction to compare for a character who does not move", () => {
    const still = blocking();
    assert.equal(screenDirectionOf(still, "Ravi"), undefined);
    const findings = analyse([
      shot({ id: "10", order: 0, blocking: still }),
      shot({ id: "11", order: 1, blocking: still }),
    ]);
    assert.ok(!categories(findings).includes("SCREEN_DIRECTION"));
  });

  it("11c. has no screen direction for a character outside the frame", () => {
    const offScreen = blocking({
      cameraStart: { x: 50, y: 85, rotation: 0, fov: 10 },
      subjects: [
        {
          id: "ravi",
          label: "Ravi",
          start: { x: 5, y: 45, orientation: 90 },
          end: { x: 95, y: 45, orientation: 90 },
          waypoints: [],
        },
      ],
    });
    assert.equal(screenDirectionOf(offScreen, "Ravi"), undefined);
  });
});

// 12-13 --- eyeline and multiple characters ----------------------------------

describe("12-13. eyeline and multiple characters", () => {
  it("12. reports a character swapping which side of frame they occupy", () => {
    const left = blocking({
      subjects: [{ id: "ravi", label: "Ravi", start: { x: 30, y: 45, orientation: 180 }, waypoints: [] }],
    });
    const right = blocking({
      subjects: [{ id: "ravi", label: "Ravi", start: { x: 70, y: 45, orientation: 180 }, waypoints: [] }],
    });
    const findings = analyse([
      shot({ id: "10", order: 0, blocking: left }),
      shot({ id: "11", order: 1, blocking: right }),
    ]);
    const eyeline = findings.find((f) => f.category === "EYELINE");
    assert.ok(eyeline);
    assert.equal(eyeline.subject, "Ravi");
    assert.equal(eyeline.severity, "REVIEW");
  });

  it("12b. invents no eyeline relationship for a shot with no blocking", () => {
    const findings = analyse([
      shot({ id: "10", order: 0, blocking: blocking() }),
      shot({ id: "11", order: 1 }),
    ]);
    assert.ok(!categories(findings).includes("EYELINE"));
  });

  it("13. tracks each character separately", () => {
    const both = (raviX: number, guardX: number) =>
      blocking({
        subjects: [
          { id: "a", label: "Ravi", start: { x: raviX, y: 45, orientation: 180 }, waypoints: [] },
          { id: "b", label: "Guard", start: { x: guardX, y: 45, orientation: 180 }, waypoints: [] },
        ],
      });
    const findings = analyse([
      shot({ id: "10", order: 0, blocking: both(30, 70) }),
      shot({ id: "11", order: 1, blocking: both(70, 70) }),
    ]);
    const eyelines = findings.filter((f) => f.category === "EYELINE");
    assert.equal(eyelines.length, 1, "only the character who moved is reported");
    assert.equal(eyelines[0].subject, "Ravi");
  });

  it("13b. reports a character blocked in one shot and not the next", () => {
    const withGuard = blocking({
      subjects: [
        { id: "a", label: "Ravi", start: { x: 40, y: 45, orientation: 180 }, waypoints: [] },
        { id: "b", label: "Guard", start: { x: 60, y: 45, orientation: 180 }, waypoints: [] },
      ],
    });
    const findings = analyse([
      shot({ id: "10", order: 0, blocking: withGuard }),
      shot({ id: "11", order: 1, blocking: blocking() }),
    ]);
    const presence = findings.find((f) => f.category === "CHARACTER_PRESENCE");
    assert.ok(presence);
    assert.equal(presence.subject, "Guard");
    assert.equal(presence.severity, "REVIEW");
  });
});

// 14-16 --- decisions --------------------------------------------------------

describe("14-16. the filmmaker's decisions", () => {
  const wardrobeChange = () =>
    analyse([
      shot({ id: "14", order: 0, wardrobe: "Charcoal overcoat" }),
      shot({ id: "15", order: 1, wardrobe: "White shirt" }),
    ]);

  it("14. marks a difference intentional without removing it", () => {
    const findings = wardrobeChange();
    const decided = applyDecisions(findings, { [findings[0].key]: "INTENTIONAL" });
    assert.equal(decided.length, 1, "the difference is still there");
    assert.equal(decided[0].status, "INTENTIONAL");
    assert.equal(decided[0].whatChanged, findings[0].whatChanged, "and still says what it is");
    assert.deepEqual(openFindings(decided), [], "but no longer needs attention");
  });

  it("15. a dismissed finding persists across re-analysis", () => {
    const decisions: Record<string, DecisionStatus> = { [wardrobeChange()[0].key]: "DISMISSED" };
    // Re-derived from scratch, as the panel does on every load.
    const decided = applyDecisions(wardrobeChange(), decisions);
    assert.equal(decided[0].status, "DISMISSED");
    assert.equal(decided.length, 1);
  });

  it("16. a marked-intentional finding persists across re-analysis", () => {
    const decisions: Record<string, DecisionStatus> = { [wardrobeChange()[0].key]: "INTENTIONAL" };
    const decided = applyDecisions(wardrobeChange(), decisions);
    assert.equal(decided[0].status, "INTENTIONAL");
  });

  it("16b. keys are stable across runs and unique per difference", () => {
    assert.equal(wardrobeChange()[0].key, wardrobeChange()[0].key);

    const three = analyse([
      shot({ id: "14", order: 0, wardrobe: "Charcoal overcoat" }),
      shot({ id: "15", order: 1, wardrobe: "White shirt" }),
      shot({ id: "16", order: 2, wardrobe: "Charcoal overcoat" }),
    ]);
    assert.equal(new Set(three.map((f) => f.key)).size, three.length, "no two findings share a key");
  });

  it("16c. a decision on one pair does not silence the same change elsewhere", () => {
    const findings = analyse([
      shot({ id: "14", order: 0, wardrobe: "Charcoal overcoat" }),
      shot({ id: "15", order: 1, wardrobe: "White shirt" }),
      shot({ id: "16", order: 2, wardrobe: "Charcoal overcoat" }),
    ]);
    const decided = applyDecisions(findings, { [findings[0].key]: "INTENTIONAL" });
    assert.equal(openFindings(decided).length, findings.length - 1);
  });
});

// 17-19 --- which shots get compared -----------------------------------------

describe("17-19. shot relationships", () => {
  it("17. compares consecutive shots in a scene", () => {
    const pairs = buildPairs({
      shots: [shot({ id: "a", order: 0 }), shot({ id: "b", order: 1 }), shot({ id: "c", order: 2 })],
      scenes: { "scene-4": STATION },
    });
    assert.deepEqual(
      pairs.map((p) => [p.a.id, p.b.id, p.relation]),
      [
        ["a", "b", "consecutive-in-scene"],
        ["b", "c", "consecutive-in-scene"],
      ]
    );
  });

  it("17b. uses `order`, not array position", () => {
    const pairs = buildPairs({
      shots: [shot({ id: "c", order: 2 }), shot({ id: "a", order: 0 }), shot({ id: "b", order: 1 })],
      scenes: { "scene-4": STATION },
    });
    assert.deepEqual(pairs.map((p) => `${p.a.id}${p.b.id}`), ["ab", "bc"]);
  });

  it("18. never compares every shot in a scene against every other", () => {
    const pairs = buildPairs({
      shots: [0, 1, 2, 3, 4].map((i) => shot({ id: `s${i}`, order: i })),
      scenes: { "scene-4": STATION },
    });
    assert.equal(pairs.length, 4, "five shots make four consecutive pairs, not ten");
  });

  it("19. does not compare shots from different scenes unless the edit relates them", () => {
    const shots = [shot({ id: "a", order: 0 }), shot({ id: "z", order: 0, sceneId: "scene-5" })];
    const scenes = { "scene-4": STATION, "scene-5": STREET };

    assert.deepEqual(buildPairs({ shots, scenes }), [], "no relation, no comparison");
    assert.equal(buildPairs({ shots, scenes, editOrder: ["a", "z"] }).length, 1);
  });

  it("19b. a day scene next to a night scene raises nothing on its own", () => {
    const day: ContinuityScene = { ...STREET, id: "scene-7", timeOfDay: "DAY" };
    const findings = analyse(
      [
        shot({ id: "a", order: 0, wardrobe: "Charcoal overcoat", lightingNotes: "Cool moonlight" }),
        shot({ id: "z", order: 0, sceneId: "scene-7", wardrobe: "Charcoal overcoat", lightingNotes: "Cool moonlight" }),
      ],
      [STATION, day]
    );
    assert.deepEqual(findings, []);
  });

  it("19c. an edit that relates them reports only what is worth reporting", () => {
    const day: ContinuityScene = { ...STREET, id: "scene-7", timeOfDay: "DAY" };
    const findings = analyse(
      [
        shot({ id: "a", order: 0, wardrobe: "Charcoal overcoat" }),
        shot({ id: "z", order: 0, sceneId: "scene-7", wardrobe: "Charcoal overcoat" }),
      ],
      [STATION, day],
      ["a", "z"]
    );
    // Same wardrobe across the cut, so nothing about the character; the
    // location difference is noted as INFO and nothing else.
    assert.deepEqual(categories(findings), ["LOCATION"]);
  });
});

// 20 --- no inference --------------------------------------------------------

describe("20. nothing is inferred from raw coordinates", () => {
  it("does not turn an arbitrary position difference into a warning", () => {
    // A few units of reframing: real in the data, meaningless as continuity.
    const nudged = blocking({
      subjects: [{ id: "ravi", label: "Ravi", start: { x: 52, y: 46, orientation: 180 }, waypoints: [] }],
    });
    const findings = analyse([
      shot({ id: "10", order: 0, blocking: blocking() }),
      shot({ id: "11", order: 1, blocking: nudged }),
    ]);
    assert.deepEqual(findings, [], "small coordinate differences are not continuity findings");
  });

  it("puts no coordinate into any finding's wording", () => {
    const findings = analyse([
      shot({
        id: "10",
        order: 0,
        blocking: blocking({
          subjects: [{ id: "ravi", label: "Ravi", start: { x: 22, y: 41, orientation: 180 }, waypoints: [] }],
        }),
      }),
      shot({
        id: "11",
        order: 1,
        blocking: blocking({
          subjects: [{ id: "ravi", label: "Ravi", start: { x: 75, y: 45, orientation: 180 }, waypoints: [] }],
        }),
      }),
    ]);
    assert.ok(findings.length > 0, "there is something to report");
    for (const finding of findings) {
      const text = `${finding.whatChanged} ${finding.whyItMayMatter}`;
      assert.ok(!/\d/.test(text), `a finding must carry no numbers:\n${text}`);
    }
  });

  it("reports ordinary coverage changes quietly, if at all", () => {
    const findings = analyse([
      shot({ id: "10", order: 0, shotType: "Wide Shot", cameraAngle: "Eye Level", composition: "Ravi centred" }),
      shot({ id: "11", order: 1, shotType: "Close-Up", cameraAngle: "Low Angle", composition: "Ravi on the left third" }),
    ]);
    assert.deepEqual(findings, [], "changing shot size, angle and composition is what coverage is");
  });

  it("notes a lens or height change as information only", () => {
    const findings = analyse([
      shot({ id: "10", order: 0, focalLength: "85mm", cameraHeight: "Chest Level" }),
      shot({ id: "11", order: 1, focalLength: "24mm", cameraHeight: "Low" }),
    ]);
    assert.equal(findings.length, 2);
    assert.ok(findings.every((f) => f.severity === "INFO"));
    assert.deepEqual(findings.map((f) => f.subject).sort(), ["Camera height", "Lens"]);
  });
});

// --- timelines ---------------------------------------------------------------

describe("character and prop timelines", () => {
  const input = (): AnalysisInput => ({
    shots: [
      shot({ id: "1", order: 0, wardrobe: "Charcoal overcoat", blocking: blocking() }),
      shot({ id: "2", order: 1, wardrobe: "Charcoal overcoat", blocking: blocking() }),
      shot({
        id: "3",
        order: 2,
        wardrobe: "Charcoal overcoat",
        blocking: blocking({
          subjects: [{ id: "ravi", label: "Ravi", start: { x: 50, y: 45, orientation: 180 }, waypoints: [] }],
        }),
      }),
      shot({ id: "4", order: 3, wardrobe: "White shirt" }),
    ],
    scenes: { "scene-4": STATION },
  });

  it("shows a character's progression shot by shot", () => {
    const timeline = characterTimeline(input(), "Ravi");
    assert.deepEqual(timeline.map((e) => e.wardrobe), [
      "Charcoal overcoat",
      "Charcoal overcoat",
      "Charcoal overcoat",
      "White shirt",
    ]);
    assert.deepEqual(timeline.map((e) => e.present), ["blocked", "blocked", "blocked", "unspecified"]);
    assert.deepEqual(timeline.map((e) => e.location), Array(4).fill(STATION.location));
  });

  it("leaves a field undefined rather than guessing it", () => {
    const timeline = characterTimeline(input(), "Ravi");
    assert.equal(timeline[3].framePosition, undefined, "no blocking, no frame position");
    assert.equal(timeline[0].hairMakeup, undefined, "never stated, so never filled in");
  });

  it("lists the characters and props actually placed on a stage", () => {
    const withProps: AnalysisInput = {
      ...input(),
      shots: [
        shot({
          id: "1",
          order: 0,
          blocking: blocking({
            subjects: [
              { id: "a", label: "Ravi", start: { x: 40, y: 45, orientation: 180 }, waypoints: [] },
              { id: "b", label: "Guard", start: { x: 60, y: 45, orientation: 180 }, waypoints: [] },
            ],
            props: [{ id: "p", label: "Platform bench", x: 20, y: 70, layer: "foreground" }],
          }),
        }),
      ],
    };
    assert.deepEqual(trackedCharacters(withProps), ["Guard", "Ravi"]);
    assert.deepEqual(trackedProps(withProps), ["Platform bench"]);
  });
});

describe("9d. an axis the camera is standing on is not comparable", () => {
  it("skips the automatic camera-to-subject axis rather than reporting nonsense", () => {
    // One subject and no stated mode: the axis runs from the camera to them, so
    // the camera is always on the line and "which side" is meaningless.
    const facing = (cameraY: number) =>
      blocking({ cameraStart: { x: 50, y: cameraY, rotation: cameraY > 50 ? 0 : 180, fov: 70 } });
    const findings = analyse([
      shot({ id: "10", order: 0, blocking: facing(85) }),
      shot({ id: "11", order: 1, blocking: facing(10) }),
    ]);
    assert.ok(!categories(findings).includes("AXIS"));
  });

  it("does compare once the axis is established by the staging", () => {
    const alongTravel = (cameraY: number) =>
      blocking({
        cameraStart: { x: 50, y: cameraY, rotation: cameraY > 50 ? 0 : 180, fov: 70 },
        subjects: [
          {
            id: "ravi",
            label: "Ravi",
            start: { x: 35, y: 48, orientation: 90 },
            end: { x: 65, y: 48, orientation: 90 },
            waypoints: [],
          },
        ],
        axis: { mode: "subject-movement", subjectId: "ravi" },
      });
    const findings = analyse([
      shot({ id: "10", order: 0, blocking: alongTravel(85) }),
      shot({ id: "11", order: 1, blocking: alongTravel(10) }),
    ]);
    assert.ok(categories(findings).includes("AXIS"));
  });
});
