import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromJsonString, toJson } from '@bufbuild/protobuf';
import fixtures from '../server/internal/api/testdata/operation-boundary.json' with { type: 'json' };
import { operationBody, operationRoutes } from '../src/lib/api/operation-routes.ts';
import { HomesteadRequestSchema } from '../src/lib/gen/glimway/v1/homestead_pb.js';
import { decodeEnvelope } from '../src/lib/api/operations.ts';
import { parseHomeAction } from '../src/lib/api/homestead.ts';

const existing = JSON.parse(readFileSync(new URL('../server/internal/api/testdata/server-first.json', import.meta.url), 'utf8')) as { name: string; case: string; json: unknown }[];
const state = existing.find(f => f.name === 'glimway.v1.PlayerState' && f.case === 'valid')!.json;

for (const f of fixtures) test(`shared operation boundary: ${f.name}`, () => {
  if (f.kind === 'mark') {
    const route = operationRoutes.mark;
    assert.equal(route.result, f.resultCase);
    const request = fromJsonString(route.schema, JSON.stringify(f.request));
    assert.deepEqual(operationBody(route, request), f.request);
    const decoded = decodeEnvelope({ state, [f.resultCase]: f.result });
    assert.equal(decoded.result.case, 'mark');
    assert.deepEqual(toJson(route.schema, request, { alwaysEmitImplicit: true }), f.request);
  } else {
    const request = fromJsonString(HomesteadRequestSchema, JSON.stringify(f.request));
    assert.deepEqual(toJson(HomesteadRequestSchema, request, { alwaysEmitImplicit: true }), f.request);
    const decoded = parseHomeAction({ state, result: f.result });
    assert.equal(decoded.result.home, null);
    assert.deepEqual(decoded.result.materials, {});
  }
});
