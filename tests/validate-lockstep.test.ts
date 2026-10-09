import test from 'node:test';
import assert from 'node:assert/strict';
import { file_buf_validate_validate } from '../src/lib/gen/buf/validate/validate_pb.js';
import { file_buf_validate_validate as runtimeFile } from '@bufbuild/protovalidate/gen/buf/validate/validate_pb.js';

/**
 * The vendored buf/validate schema is generated into src/lib/gen once and
 * shared by every content schema; the protovalidate runtime carries its own
 * copy of the same descriptors and ignores an option it doesn't know. If the
 * two copies drift — the vendored file moved without bumping the runtime, or
 * the other way round — a rule the schema sets is silently dropped on one
 * side, and the loaders disagree with no error anywhere. Keep the vendored
 * file, the runtimes (Go's `buf.build/go/protovalidate` and
 * `@bufbuild/protovalidate`) and this generated copy in lockstep: they bump
 * together (see .agent/PATTERN.md).
 */
test('the vendored buf/validate schema is the one the runtime ships', () => {
  assert.equal(file_buf_validate_validate.kind, 'file');
  assert.deepEqual(
    file_buf_validate_validate.messages.map((m) => m.typeName).sort(),
    runtimeFile.messages.map((m) => m.typeName).sort(),
    'the message types drifted between the vendored schema and the runtime',
  );
  // Every rule field, by message, number and name — the parts the content
  // schemas' options refer to.
  const fieldsOf = (file: typeof runtimeFile) => {
    const out: Record<string, [number, string][]> = {};
    for (const m of file.messages) {
      out[m.typeName] = m.fields.map((f) => [f.number, f.name] as [number, string]).sort((a, b) => a[0] - b[0]);
    }
    return out;
  };
  assert.deepEqual(fieldsOf(file_buf_validate_validate), fieldsOf(runtimeFile));
  // The enums the rule fields point at (their `in` lists are the rule ids' vocabulary).
  const enumsOf = (file: typeof runtimeFile) =>
    file.enums.map((e) => [e.typeName, e.values.map((v) => v.name).sort()] as const).sort();
  assert.deepEqual(enumsOf(file_buf_validate_validate), enumsOf(runtimeFile));
  // The constraint extensions are the part the content schemas import;
  // compare their numbers too (an unknown extension is silently ignored).
  const extensionsOf = (file: typeof runtimeFile) =>
    file.extensions.map((x) => `${x.parent?.typeName}.${x.name}:${x.number}`).sort();
  assert.deepEqual(extensionsOf(file_buf_validate_validate), extensionsOf(runtimeFile));
});
