import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TITLE,
  LANDING_EDGE_INSET,
  SPIN_DURATION_MIN,
  SPIN_DURATION_VARIANCE,
  SPIN_TURNS_MIN,
  SPIN_TURNS_VARIANCE,
  TAU,
  createWheelId,
  easeOutSpin,
  normalizeAngle,
  normalizeCenterImage,
  normalizeName,
  normalizeServerState,
  normalizeTitle,
  planSpin,
  sanitizeWheelId,
  sliceUnderPointer
} from "../wheel-core.js";

// Small seeded PRNG so randomized tests are reproducible.
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("normalizeName", () => {
  test("collapses whitespace and trims", () => {
    assert.equal(normalizeName("  Ada \n\t Lovelace  "), "Ada Lovelace");
  });

  test("caps names at 80 characters", () => {
    assert.equal(normalizeName("x".repeat(200)).length, 80);
  });

  test("treats missing values as empty", () => {
    assert.equal(normalizeName(undefined), "");
    assert.equal(normalizeName(null), "");
    assert.equal(normalizeName("   "), "");
  });
});

describe("normalizeTitle", () => {
  test("collapses whitespace and caps at 60 characters", () => {
    assert.equal(normalizeTitle("  Team   lunch  "), "Team lunch");
    assert.equal(normalizeTitle("y".repeat(100)).length, 60);
  });
});

describe("normalizeCenterImage", () => {
  test("accepts the palette colours only", () => {
    assert.equal(normalizeCenterImage("color:#0f766e"), "color:#0f766e");
    assert.equal(normalizeCenterImage("color:#123456"), "");
  });

  test("accepts supported image data URLs", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    assert.equal(normalizeCenterImage(png), png);
  });

  test("rejects unsafe or unsupported values", () => {
    assert.equal(normalizeCenterImage("javascript:alert(1)"), "");
    assert.equal(normalizeCenterImage("data:image/svg+xml;base64,PHN2Zz4="), "");
    assert.equal(normalizeCenterImage("https://example.com/a.png"), "");
    assert.equal(normalizeCenterImage(42), "");
  });
});

describe("wheel IDs", () => {
  test("sanitizeWheelId keeps URL-safe IDs of 6-32 characters", () => {
    assert.equal(sanitizeWheelId(" abc123 "), "abc123");
    assert.equal(sanitizeWheelId("abc"), "");
    assert.equal(sanitizeWheelId("a".repeat(33)), "");
    assert.equal(sanitizeWheelId("abc/../123"), "");
    assert.equal(sanitizeWheelId(null), "");
  });

  test("createWheelId makes valid 12-character IDs without look-alike characters", () => {
    for (let i = 0; i < 200; i += 1) {
      const id = createWheelId();
      assert.equal(id.length, 12);
      assert.equal(sanitizeWheelId(id), id);
      assert.doesNotMatch(id, /[l01]/);
    }
  });

  test("createWheelId uses the supplied random source", () => {
    const id = createWheelId((bytes) => bytes.fill(0));
    assert.equal(id, "a".repeat(12));
  });
});

describe("normalizeServerState", () => {
  test("fills defaults for empty or junk input", () => {
    for (const input of [undefined, null, {}, "nope"]) {
      assert.deepEqual(normalizeServerState(input), {
        title: DEFAULT_TITLE,
        centerImage: "",
        names: [],
        lastWinner: "",
        lastWinnerAt: 0,
        lastWinnerId: ""
      });
    }
  });

  test("drops invalid names and sorts by creation time", () => {
    const state = normalizeServerState({
      names: [
        { id: "b", text: "Second", createdAt: 2 },
        { id: "", text: "No id", createdAt: 0 },
        { id: "c", text: "   ", createdAt: 3 },
        null,
        { id: "a", text: " First ", createdAt: 1 }
      ]
    });
    assert.deepEqual(state.names, [
      { id: "a", text: "First", createdAt: 1 },
      { id: "b", text: "Second", createdAt: 2 }
    ]);
  });
});

describe("angles", () => {
  test("normalizeAngle wraps into [0, TAU)", () => {
    assert.equal(normalizeAngle(0), 0);
    assert.ok(Math.abs(normalizeAngle(-Math.PI / 2) - (3 * Math.PI) / 2) < 1e-12);
    assert.ok(Math.abs(normalizeAngle(TAU * 5 + 1) - 1) < 1e-9);
  });

  test("sliceUnderPointer finds the slice at the top of the wheel", () => {
    const slice = TAU / 4;
    assert.equal(sliceUnderPointer(0, slice), 0);
    // Turning the wheel back by one and a half slices brings slice 1 under the pointer.
    assert.equal(sliceUnderPointer(-1.5 * slice, slice), 1);
    // Turning forward by half a slice brings the last slice under the pointer.
    assert.equal(sliceUnderPointer(0.5 * slice, slice), 3);
  });
});

describe("easeOutSpin", () => {
  test("starts at 0, ends at 1, and clamps out-of-range progress", () => {
    assert.equal(easeOutSpin(0), 0);
    assert.equal(easeOutSpin(1), 1);
    assert.equal(easeOutSpin(-1), 0);
    assert.equal(easeOutSpin(2), 1);
  });

  test("never moves backwards", () => {
    let previous = 0;
    for (let p = 0; p <= 1; p += 0.001) {
      const value = easeOutSpin(p);
      assert.ok(value >= previous);
      previous = value;
    }
  });

  test("covers most of the distance early, then crawls", () => {
    assert.ok(easeOutSpin(0.5) > 0.9);
    assert.ok(1 - easeOutSpin(0.9) < 0.001);
  });
});

describe("planSpin", () => {
  test("always lands inside the chosen winner's slice, away from its edges", () => {
    const random = seededRandom(1234);
    for (let run = 0; run < 2000; run += 1) {
      const nameCount = 1 + Math.floor(random() * 40);
      const start = (random() * 2 - 1) * TAU * 10;
      const plan = planSpin(nameCount, start, random);

      assert.ok(plan.winnerIndex >= 0 && plan.winnerIndex < nameCount);
      assert.equal(sliceUnderPointer(plan.targetRotation, plan.slice), plan.winnerIndex);

      const positionInSlice = normalizeAngle(-plan.targetRotation) / plan.slice - plan.winnerIndex;
      assert.ok(positionInSlice >= LANDING_EDGE_INSET - 1e-9, `too close to leading edge: ${positionInSlice}`);
      assert.ok(positionInSlice <= 1 - LANDING_EDGE_INSET + 1e-9, `too close to trailing edge: ${positionInSlice}`);
    }
  });

  test("spins forward a bounded number of full turns", () => {
    const random = seededRandom(99);
    for (let run = 0; run < 500; run += 1) {
      const start = random() * TAU;
      const plan = planSpin(8, start, random);
      const turns = (plan.targetRotation - start) / TAU;
      assert.ok(turns >= SPIN_TURNS_MIN, `only ${turns} turns`);
      assert.ok(turns < SPIN_TURNS_MIN + SPIN_TURNS_VARIANCE, `${turns} turns`);
    }
  });

  test("keeps the duration in the configured window", () => {
    assert.equal(planSpin(5, 0, () => 0).duration, SPIN_DURATION_MIN);
    const longest = planSpin(5, 0, () => 0.999999).duration;
    assert.ok(longest < SPIN_DURATION_MIN + SPIN_DURATION_VARIANCE);
  });

  test("handles the extremes of the random source", () => {
    assert.equal(planSpin(6, 0, () => 0).winnerIndex, 0);
    assert.equal(planSpin(6, 0, () => 0.999999).winnerIndex, 5);
  });

  test("gives every name a fair chance", () => {
    const random = seededRandom(42);
    const counts = [0, 0, 0, 0];
    const runs = 20000;
    for (let run = 0; run < runs; run += 1) {
      counts[planSpin(4, 0, random).winnerIndex] += 1;
    }
    for (const count of counts) {
      assert.ok(Math.abs(count / runs - 0.25) < 0.02, `uneven distribution: ${counts}`);
    }
  });
});
