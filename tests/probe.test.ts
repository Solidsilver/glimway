import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fromJson } from '@bufbuild/protobuf';
import { createValidator } from '@bufbuild/protovalidate';
import { FurnishingsSchema } from '../src/lib/gen/glimway/content/v1/furnishings_pb.js';
import { RoomsSchema } from '../src/lib/gen/glimway/content/v1/rooms_pb.js';
import { ResidentsSchema } from '../src/lib/gen/glimway/content/v1/residents_pb.js';

const validator = createValidator();
function edited(base: unknown, edits: { path: (string | number)[]; value: unknown }[]): unknown {
  const value = structuredClone(base);
  for (const e of edits) {
    let target = value as any;
    for (const key of e.path.slice(0, -1)) target = target[key];
    target[e.path.at(-1)!] = e.value;
  }
  return value;
}
function run(file: string, name: string, schema: any, raw: unknown, vectors: any[]) {
  for (const v of vectors) {
    let status = 'ok';
    try {
      const msg = fromJson(schema, edited(raw, v.edits));
      const result = validator.validate(schema, msg);
      if (result.kind !== 'valid') status = 'validate: ' + result.violations.map((x: any) => `${x.field}: ${x.message}`).join('; ');
    } catch (err) {
      status = 'decode: ' + String(err).split('\n')[0];
    }
    const mark = (status === 'ok') === v.valid ? 'PASS' : 'MISS';
    console.log(`${mark} ${name}/${v.name} want_valid=${v.valid} ${status}`);
  }
}
test('probe vectors', () => {
  const furn = JSON.parse(readFileSync(new URL('../content/vectors/furnishings.json', import.meta.url), 'utf8'));
  const furnRaw = JSON.parse(readFileSync(new URL('../content/furnishings.json', import.meta.url), 'utf8'));
  run('furnishings', 'furnishings', FurnishingsSchema, furnRaw, furn.loader);
  const rooms = JSON.parse(readFileSync(new URL('../content/vectors/rooms.json', import.meta.url), 'utf8'));
  const roomRaw = JSON.parse(readFileSync(new URL('../content/rooms.json', import.meta.url), 'utf8'));
  const residentRaw = JSON.parse(readFileSync(new URL('../content/residents.json', import.meta.url), 'utf8'));
  run('rooms', 'rooms', RoomsSchema, roomRaw, rooms.rooms);
  run('residents', 'residents', ResidentsSchema, residentRaw, rooms.residents);
});
