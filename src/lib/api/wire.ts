import { fromJson, ScalarType, type DescMessage, type JsonValue, type MessageShape } from '@bufbuild/protobuf';

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid message');
  return value as Record<string, unknown>;
};
function scalar(type: ScalarType, value: unknown): void {
  if (type === ScalarType.STRING || type === ScalarType.BYTES) {
    if (typeof value !== 'string') throw new Error('invalid string');
  } else if (type === ScalarType.BOOL) {
    if (typeof value !== 'boolean') throw new Error('invalid boolean');
  } else {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid number');
    if (type !== ScalarType.DOUBLE && type !== ScalarType.FLOAT && !Number.isSafeInteger(value)) throw new Error('invalid integer');
  }
}
function message(schema: DescMessage, raw: unknown): void {
  if (schema.typeName === 'google.protobuf.Value') {
    if (typeof raw === 'number' && !Number.isFinite(raw)) throw new Error('invalid value');
    return;
  }
  if (schema.typeName === 'google.protobuf.StringValue') { if (raw !== null) scalar(ScalarType.STRING, raw); return; }
  if (schema.typeName === 'google.protobuf.DoubleValue') { if (raw !== null) scalar(ScalarType.DOUBLE, raw); return; }
  if (raw === null) return;
  const input = record(raw);
  for (const field of schema.fields) {
    if (field.name !== field.jsonName && Object.hasOwn(input, field.name)) throw new Error('unexpected proto-name alias');
    const value = input[field.jsonName];
    if (value === undefined) {
      if (!field.oneof && !field.proto.proto3Optional) throw new Error('missing field');
      continue;
    }
    switch (field.fieldKind) {
      case 'scalar': scalar(field.scalar, value); break;
      case 'message': message(field.message, value); break;
      case 'enum': if (typeof value !== 'string') throw new Error('invalid enum'); break;
      case 'list':
        if (!Array.isArray(value)) throw new Error('invalid list');
        for (const entry of value) {
          if (field.listKind === 'scalar') scalar(field.scalar, entry);
          else if (field.listKind === 'message') message(field.message, entry);
          else if (typeof entry !== 'string') throw new Error('invalid enum');
        }
        break;
      case 'map':
        for (const entry of Object.values(record(value))) {
          if (field.mapKind === 'scalar') scalar(field.scalar, entry);
          else if (field.mapKind === 'message') message(field.message, entry);
          else if (typeof entry !== 'string') throw new Error('invalid enum');
        }
        break;
    }
  }
}

/** HTTP has one JSON spelling and numeric scalars, unlike permissive ProtoJSON. */
export function decodeWire<D extends DescMessage>(schema: D, raw: unknown): MessageShape<D> {
  message(schema, raw);
  return fromJson(schema, raw as JsonValue, { ignoreUnknownFields: true });
}
