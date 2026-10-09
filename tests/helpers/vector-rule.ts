/**
 * The shared vectors (content/vectors/*.json) name the rule a refusal fires
 * for: a protovalidate rule id ("string.pattern", "furnishing.rug") carried
 * in the error text in brackets, or — for the rules the loaders keep in code
 * and the pre-parse checks — the message's own tag ("duplicate id", "stair
 * target", "unknown key"). Both languages' errors must carry it.
 */
export function refusalMatchesRule(err: unknown, rule: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(`[${rule}]`) || message.includes(rule);
}
