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
      const escaped = pattern[index + 1];
      if (escaped === undefined) {
        // A trailing escape still fails exactly like before; tracked separately in #22.
        throw new TypeError("Cannot read properties of undefined (reading 'toLowerCase')");
      }
      // Keep the escaped character verbatim so its case is preserved (#25).
      tokens.push({ type: "literal", value: escaped });
      index += 1;
      continue;
    }

    tokens.push({ type: "literal", value: char });
  }

  return tokens;
}
