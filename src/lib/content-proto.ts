import { fromJson, type DescField, type DescMessage, type MessageShape } from '@bufbuild/protobuf';
import { createValidator, type Violation } from '@bufbuild/protovalidate';

/**
 * Content files are JSON read into the generated proto messages
 * (proto/glimway/content/v1), the TypeScript twin of content/protojson.go:
 * before `fromJson` runs (it refuses unknown fields), refuseContent checks
 * the parsed JSON against the schema's descriptors — any explicit null is
 * refused (fromJson reads a null as "unset", the hand-written loaders
 * treated a null as an error), and so is any key that isn't a field's
 * canonical JSON name (a proto name alone included, which fromJson would
 * otherwise accept). Then protovalidate runs the schema's field and message
 * rules; rules that span entries stay in each family's loader.
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
 * Reads raw content into the generated message, refusing nulls and unknown
 * keys, then runs the schema's rules. Violations are reported the way the Go
 * loader does: naming the entry and the field ("candle base.w: ...").
 * `family` names the file ("furnishings"); `entryFields` are the proto names
 * of the repeated fields the entries live in ("pieces" — several for a file
 * with more than one list), each resolved through the descriptor.
 */
export function decodeContent<Desc extends DescMessage>(schema: Desc, raw: unknown, family: string, entryFields: string[]): MessageShape<Desc> {
  try {
    refuseContent('content', raw, schema);
  } catch (e) {
    throw new Error(`invalid ${family}: ${(e as Error).message}`);
  }
  let msg: MessageShape<Desc>;
  try {
    msg = fromJson(schema, raw as never);
  } catch (e) {
    throw new Error(`invalid ${family}: decode: ${(e as Error).message}`);
  }
  const entries = entryFields.map((field) => {
    // entryFields spell the fields as the violation paths do (the JSON
    // name); the message is read through the field's localName.
    const fd = schema.fields.find((f) => f.jsonName === field) ?? schema.fields.find((f) => f.name === field);
    const list = fd ? (msg as unknown as Record<string, { id?: string }[] | undefined>)[fd.localName] : undefined;
    return { field: fd ? fd.jsonName : field, ids: (list ?? []).map((e) => e.id ?? '') };
  });
  const result = validator.validate(schema, msg);
  if (result.kind === 'valid') return msg;
  if (result.kind === 'error') throw result.error;
  const issues = result.violations.map((v) => nameEntry(entries, violationIssue(v)));
  throw new ContentValidationError(`invalid ${family}: ${issues.join('; ')}`, result.violations.map((v) => v.ruleId));
}

// refuseContent walks the parsed content beside the message descriptor,
// refusing any explicit null and any key that isn't a field's JSON name,
// naming the entry by its id ("content.pieces[candle].offers").
function refuseContent(path: string, v: unknown, md: DescMessage): void {
  if (v === null) throw new Error(`null content field ${path}`);
  if (typeof v !== 'object' || Array.isArray(v)) return; // scalars and lists are fromJson's business
  // Sorted, so with two problems the same one is reported every run.
  const obj = v as Record<string, unknown>;
  for (const key of Object.keys(obj).sort()) {
    const fd = md.fields.find((f) => f.jsonName === key);
    if (!fd) {
      const byName = md.fields.find((f) => f.name === key);
      if (byName) throw new Error(`key "${key}" at ${path} is the proto name; use the JSON name "${byName.jsonName}"`);
      throw new Error(`unknown key "${key}" at ${path}`);
    }
    refuseField(`${path}.${key}`, obj[key], fd);
  }
}

function refuseField(path: string, v: unknown, fd: DescField): void {
  if (v === null) throw new Error(`null content field ${path}`);
  if (fd.fieldKind === 'list') {
    if (!Array.isArray(v)) return;
    v.forEach((item, i) => {
      // A list of messages names its entries by id ("pieces[candle]").
      let name = String(i);
      const entry = item as { id?: unknown } | null;
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string' && entry.id !== '') name = entry.id;
      refuseSingular(`${path}[${name}]`, item, fd);
    });
    return;
  }
  if (fd.fieldKind === 'map') {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return;
    // Map keys are data, not schema: only the values are walked.
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      refuseSingular(`${path}[${JSON.stringify(key)}]`, (v as Record<string, unknown>)[key], fd);
    }
    return;
  }
  refuseSingular(path, v, fd);
}

function refuseSingular(path: string, v: unknown, fd: DescField): void {
  if (v === null) throw new Error(`null content field ${path}`);
  if (fd.message) refuseContent(path, v, fd.message);
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
