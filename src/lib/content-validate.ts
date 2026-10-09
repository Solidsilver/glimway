import { getExtension, type DescMessage, type MessageShape } from '@bufbuild/protobuf';
import { createValidator, type Violation } from '@bufbuild/protovalidate';
import { message as messageRulesExt, field as fieldRulesExt } from './gen/buf/validate/validate_pb.js';

/**
 * The schema's field and message rules (protovalidate and its CEL), run on
 * a decoded content message. content-proto.ts loads this module only
 * outside a production build: the content files bundled into the client are
 * validated by the shared vectors in CI (both languages) and by the server
 * at start-up, so a player's browser skips the rules — and the validator,
 * CEL and RE2 aren't in its bundle.
 */
const validator = createValidator();

/** A refusing loader error that came from the schema, with the rule ids that fired (the shared vectors name one). */
export class ContentValidationError extends Error {
  readonly ruleIds: string[];
  constructor(message: string, ruleIds: string[]) {
    super(message);
    this.name = 'ContentValidationError';
    this.ruleIds = ruleIds;
  }
}

/** One repeated field's entries, by proto field name and each entry's id. */
interface EntryList { field: string; ids: string[] }

/**
 * Runs the schema's rules on a decoded message. Violations are reported the
 * way the Go loader does: naming the entry and the field
 * ("candle base.w: ..."). `family` names the file ("furnishings");
 * `entryFields` are the proto names of the repeated fields the entries live
 * in ("pieces" — several for a file with more than one list), each resolved
 * through the descriptor.
 */
export function validateContent<Desc extends DescMessage>(schema: Desc, msg: MessageShape<Desc>, family: string, entryFields: string[]): void {
  const entries = entryFields.map((field) => {
    // entryFields spell the fields as the violation paths do (the JSON
    // name); the message is read through the field's localName.
    const fd = schema.fields.find((f) => f.jsonName === field) ?? schema.fields.find((f) => f.name === field);
    const list = fd ? (msg as unknown as Record<string, { id?: string }[] | undefined>)[fd.localName] : undefined;
    return { field: fd ? fd.jsonName : field, ids: (list ?? []).map((e) => e.id ?? '') };
  });
  const result = validator.validate(schema, msg);
  if (result.kind === 'valid') return;
  if (result.kind === 'error') {
    // A CEL rule that errors mid-evaluation (a timestamp() conversion over
    // a malformed string) comes back as a bare RuntimeError without the
    // rule's id — Go's runtime names it in the text. Map it onto the rules
    // being evaluated (the schema's CEL ids), so both runtimes' texts carry
    // the id the shared vectors assert.
    const ids = celRuleIds(schema);
    throw new ContentValidationError(`invalid ${family}: ${result.error.message}${ids.length > 0 ? ` [${ids.join(', ')}]` : ''}`, ids);
  }
  const issues = result.violations.map((v) => nameEntry(entries, violationIssue(v)));
  throw new ContentValidationError(`invalid ${family}: ${issues.join('; ')}`, result.violations.map((v) => v.ruleId));
}

// celRuleIds collects the CEL rule ids declared on the schema's message
// tree — the message rules and the field rules (the generated descriptors
// keep the options; the runtime's own errors don't name the rule).
function celRuleIds(desc: DescMessage): string[] {
  const ids: string[] = [];
  const optionsOf = (o: unknown): { options?: object } | undefined => (o as { proto?: { options?: object } } | undefined)?.proto;
  const visit = (md: DescMessage): void => {
    const opts = optionsOf(md)?.options;
    if (opts) {
      try {
        const rules = getExtension(opts as never, messageRulesExt);
        for (const c of rules?.cel ?? []) if (c.id) ids.push(c.id);
      } catch { /* no message rules */ }
    }
    for (const f of md.fields) {
      const fo = optionsOf(f)?.options;
      if (!fo) continue;
      try {
        const rules = getExtension(fo as never, fieldRulesExt);
        for (const c of rules?.cel ?? []) if (c.id) ids.push(c.id);
      } catch { /* no field rules */ }
    }
    for (const n of md.nestedMessages) visit(n);
  };
  visit(desc);
  return ids;
}

// violationIssue renders one violation as "path: message", with the path's
// field names spelled the way the JSON files do (period_minutes ->
// periodMinutes).
// The rule id stays in the text: the shared vectors name the rule they
// refuse for, and both runtimes' errors must carry it.
function violationIssue(v: Violation): string {
  let path = '';
  for (const el of v.field) {
    if (el.kind === 'list_sub') { path += `[${el.index}]`; continue; }
    if (el.kind === 'map_sub') { path += `[${JSON.stringify(el.key)}]`; continue; }
    if (el.kind === 'extension') { path += `[${el.typeName}]`; continue; }
    if (el.kind === 'oneof') { path += (path ? '.' : '') + el.name; continue; }
    if (path) path += '.';
    path += el.jsonName;
  }
  return path ? `${path}: ${v.message} [${v.ruleId}]` : `${v.message} [${v.ruleId}]`;
}

const entryPath = /^(\w+)\[(\d+)\]\.?(.*)$/;

// nameEntry rewrites a violation path ("pieces[2].base.w: ...") to name the
// entry ("candle base.w: ..."); ids[i] names the entry in the message's
// field (pieces, rooms, residents).
function nameEntry(entries: EntryList[], issue: string): string {
  const m = entryPath.exec(issue);
  if (!m) return issue;
  for (const e of entries) {
    if (e.field !== m[1]) continue;
    const i = Number(m[2]);
    if (!Number.isSafeInteger(i) || i < 0 || i >= e.ids.length) return issue;
    // A message rule's path ends at the entry ("hazel: home is ...").
    if (m[3] === '') return e.ids[i]!;
    if (m[3]!.startsWith(':')) return `${e.ids[i]}${m[3]}`;
    return `${e.ids[i]} ${m[3]}`;
  }
  return issue;
}
