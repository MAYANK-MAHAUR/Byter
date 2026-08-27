import type { MinimizationResult } from "./types.js";

export function removeNonEssentialLines(source: string, requiredNeedles: string[]): MinimizationResult {
  const lines = source.split(/\r?\n/);
  const kept: string[] = [];
  const removedLineNumbers: number[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const hasRequiredNeedle = requiredNeedles.some((needle) => line.includes(needle));
    const removable = trimmed.length === 0 || trimmed.startsWith("//") || trimmed.startsWith("#");

    if (removable && !hasRequiredNeedle) {
      removedLineNumbers.push(index + 1);
      return;
    }

    kept.push(line);
  });

  return {
    originalLineCount: lines.length,
    minimizedLineCount: kept.length,
    source: kept.join("\n"),
    removedLineNumbers
  };
}
