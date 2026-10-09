/**
 * The shared vectors (content/vectors/*.json) name the rule a refusal fires
 * for: a protovalidate rule id ("string.pattern", "furnishing.rug") carried
 * in the error text in brackets, or — for the rules the loaders keep in code
 * and the pre-parse checks — the message's own tag ("duplicate id", "stair
 * target", "unknown key"). Both languages' errors must carry it.
 */
const RULE_ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
export function refusalMatchesRule(err: unknown, rule: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // A dotted rule id must appear as a whole member of a bracket group —
  // "[string.pattern]", or the multi-id form one runtime renders for a CEL
  // that errors mid-evaluation ("[calendar.epoch, calendar.festivals]").
  // A prefix ("[int32.gte]" for "int32.gte_lte") does not count.
  if (RULE_ID.test(rule)) {
    for (const group of message.matchAll(/\[([^\]]*)\]/g)) {
      if (group[1]!.split(',').map((id) => id.trim()).includes(rule)) return true;
    }
    return false;
  }
  return message.includes(rule);
}
