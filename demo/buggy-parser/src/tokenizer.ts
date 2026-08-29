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
        tokens.push({ type: "literal", value: "\\" });
        continue;
      }
      tokens.push({ type: "literal", value: escaped.toLowerCase() });
      index += 1;
      continue;
    }

    tokens.push({ type: "literal", value: char });
  }

  return tokens;
}
