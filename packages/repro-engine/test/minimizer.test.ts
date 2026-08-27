import { describe, expect, it } from "vitest";
import { removeNonEssentialLines } from "../src/index.js";

describe("MRE minimizer primitives", () => {
  it("removes blank and comment lines while preserving required lines", () => {
    const result = removeNonEssentialLines(
      ["// setup", "const input = '\\\\';", "", "tokenizePattern(input);", "// expected crash"].join("\n"),
      ["tokenizePattern", "input"]
    );

    expect(result.originalLineCount).toBe(5);
    expect(result.minimizedLineCount).toBe(2);
    expect(result.source).toContain("tokenizePattern(input);");
    expect(result.removedLineNumbers).toEqual([1, 3, 5]);
  });
});
