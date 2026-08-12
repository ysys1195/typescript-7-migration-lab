import { describe, expect, it } from "vitest";
import { sum } from "../src/math.js";

describe("sum", () => {
  it("adds two numbers", () => {
    expect(sum(20, 7)).toBe(27);
  });
});
