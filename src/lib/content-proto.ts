import { fromJson, ScalarType, type DescField, type DescMessage, type MessageShape } from '@bufbuild/protobuf';

/**
 * Content files are JSON read into the generated proto messages
 * (proto/glimway/content/v1), the TypeScript twin of content/protojson.go:
 * before `fromJson` runs (it refuses unknown fields), refuseContent checks
 * the parsed JSON against the schema's descriptors — any explicit null is
 * refused (fromJson reads a null as "unset", the hand-written loaders
 * treated a null as an error), and so is any key that isn't a field's
 * canonical JSON name (a proto name alone included, which fromJson would
 * otherwise accept). Then protovalidate runs the schema's field and message
 * rules (content-validate.ts); rules that span entries stay in each
 * family's loader.
 *
 * Except in a production build: the bundled content is already validated
 * by the shared vectors in CI and by the server at start-up, so a player's
 * browser skips the schema's rules, and the dead branch below takes the
 * validator, CEL and RE2 out of the bundle. Dev, `npm test`, the vectors
 * and e2e (the dev server) all validate. `?.`: Node has no import.meta.env.
 */
const validate = import.meta.env?.PROD ? undefined : (await import('./content-validate.ts')).validateContent;

/**
 * Reads raw content into the generated message, refusing nulls and unknown
 * keys, then (outside production) runs the schema's rules. `family` names
 * the file ("furnishings"); `entryFields` are the proto names of the
 * repeated fields the entries live in ("pieces"), naming the entry in a
 * violation ("candle base.w: ...").
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
  validate?.(schema, msg, family, entryFields);
  return msg;
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
  // A numeric scalar is a JSON number, and a finite one: numeric strings
  // ("3", and the "Infinity"/"-Infinity"/"NaN" spellings fromJson would
  // take) are refused, as is any number the parse left non-finite. One
  // rule id for every position — singular, repeated and map values (the
  // Go loader's content/protojson.go carries the same one).
  else if (fd.scalar !== undefined && NUMERIC_SCALARS.has(fd.scalar)) {
    if (typeof v === 'string') throw new Error(`non-finite number at ${path}: numeric strings are refused (${JSON.stringify(v)})`);
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`non-finite number at ${path}`);
  }
}

const NUMERIC_SCALARS = new Set([
  ScalarType.INT32, ScalarType.INT64, ScalarType.UINT32, ScalarType.UINT64,
  ScalarType.SINT32, ScalarType.SINT64, ScalarType.FIXED32, ScalarType.FIXED64,
  ScalarType.SFIXED32, ScalarType.SFIXED64, ScalarType.FLOAT, ScalarType.DOUBLE,
]);
