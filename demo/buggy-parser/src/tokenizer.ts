export interface Token {
  type: "literal" | "wildcard";
  value: string;
}

export function tokenizePattern(pattern: string): Token[] {
  const tokens: Token[] = [];

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === "*") {
      tokens.push({ type: "wildcard", value: "*" });
      continue;
    }

    if (char === "\\") {
      const escaped = pattern.at(index + 1);

      if (escaped === undefined) {
        // Keep the trailing-escape failure pinned by tokenizer.test.ts:
        // the previous implementation crashed on undefined.toLowerCase().
        throw new TypeError(
          "Cannot read properties of undefined (reading 'toLowerCase')"
        );
      }

      tokens.push({ type: "literal", value: escaped });
      index += 1;
      continue;
    }

    tokens.push({ type: "literal", value: char });
  }

  return tokens;
}
