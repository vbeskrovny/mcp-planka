import { describe, expect, it } from "vitest";
import { computePosition, POSITION_GAP } from "../../src/position.js";

describe("computePosition", () => {
  it("returns GAP for an empty list", () => {
    expect(computePosition([], "top")).toBe(POSITION_GAP);
    expect(computePosition([])).toBe(POSITION_GAP);
  });
  it("bottom = max + GAP (default)", () => {
    expect(computePosition([65536, 131072])).toBe(131072 + POSITION_GAP);
    expect(computePosition([131072, 65536], "bottom")).toBe(131072 + POSITION_GAP);
  });
  it("top = first / 2", () => {
    expect(computePosition([65536, 131072], "top")).toBe(32768);
  });
  it("index inserts between neighbours", () => {
    expect(computePosition([65536, 131072, 196608], 1)).toBe((65536 + 131072) / 2);
    expect(computePosition([65536, 131072, 196608], 0)).toBe(32768);
  });
  it("index past end means bottom; negative clamps to top", () => {
    expect(computePosition([65536], 10)).toBe(65536 + POSITION_GAP);
    expect(computePosition([65536], -3)).toBe(32768);
  });
  it("always returns a positive number", () => {
    expect(computePosition([0.0001], "top")).toBeGreaterThan(0);
  });
});
