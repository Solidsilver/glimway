import { fromJson, type DescMessage, type MessageShape } from '@bufbuild/protobuf';
import { createValidator } from '@bufbuild/protovalidate';

/**
 * Content files are JSON read into the generated proto messages
 * (proto/glimway/content/v1), the TypeScript twin of content/protojson.go:
 * `fromJson` refuses unknown fields; explicit nulls are refused here, because
 * fromJson reads a null as "unset" and the hand-written loaders treated a null
 * as an error. Then protovalidate runs the schema's field and message rules;
 * rules that span entries stay in each family's loader.
 */
const validator = createValidator();

/**
 * Reads raw content into the generated message, refusing nulls and unknown
 * fields, then runs the schema's rules. Violations are reported the way the
 * Go loader does: naming the entry and the field ("candle base.w: ...").
 * `family` names the file ("furnishings") and `field` the repeated field the
 * entries live in ("pieces").
 */
export function decodeContent<Desc extends DescMessage>(schema: Desc, raw: unknown, family: string, field: string): MessageShape<Desc> {
  refuseNulls(raw);
  const msg = fromJson(schema, raw as never);
  const result = validator.validate(schema, msg);
  if (result.kind === 'valid') return msg;
  if (result.kind === 'error') throw result.error;
  const ids = ((msg as unknown as Record<string, { id?: string }[] | undefined>)[field] ?? []).map((e) => e.id ?? '');
  throw new Error(`invalid ${family}: ${result.violations.map((v) => nameEntry(field, ids, v.toString())).join('; ')}`);
}

// refuseNulls walks the parsed content and refuses any explicit null, naming
// the entry by its id when the object has one ("pieces[candle].offers").
function refuseNulls(raw: unknown): void {
  refuseNullsIn('content', raw);
}

function refuseNullsIn(path: string, v: unknown): void {
  if (v === null) throw new Error(`null content field ${path}`);
  if (Array.isArray(v)) {
    v.forEach((item, i) => refuseNullsIn(`${path}[${i}]`, item));
    return;
  }
  if (typeof v === 'object') {
    for (const [key, item] of Object.entries(v)) {
      let child = `${path}.${key}`;
      const entry = item as { id?: unknown } | null;
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string' && entry.id !== '') {
        child = `${path}[${entry.id}]`;
      }
      refuseNullsIn(child, item);
    }
  }
}

const entryPath = /^(\w+)\[(\d+)\]\.?(.*)$/;

// nameEntry rewrites a violation path ("pieces[2].base.w: ...") to name the
// entry ("candle base.w: ..."). ids[i] names the entry in the message's field
// (pieces, rooms, residents).
function nameEntry(field: string, ids: string[], issue: string): string {
  const m = entryPath.exec(issue);
  if (!m || m[1] !== field) return issue;
  const i = Number(m[2]);
  if (!Number.isSafeInteger(i) || i < 0 || i >= ids.length) return issue;
  return m[3] ? `${ids[i]} ${m[3]}` : ids[i]!;
}
