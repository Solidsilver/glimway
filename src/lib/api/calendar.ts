import { fromJson } from '@bufbuild/protobuf';
import type { JsonValue } from '@bufbuild/protobuf';
import { CalendarResponseSchema, type CalendarResponse as GeneratedCalendarResponse } from '../gen/glimway/v1/calendar_pb.js';
import { ApiError } from './errors.ts';

/** Existing HTTP nulls are normalized from protobuf wrapper absence. */
export type CalendarResponse = Omit<GeneratedCalendarResponse, '$typeName' | '$unknown' | 'festival' | 'notice'> & {
  festival: string | null;
  notice: string | null;
};

export function parseCalendar(raw: unknown): CalendarResponse {
  try {
    const day = fromJson(CalendarResponseSchema, raw as JsonValue, { ignoreUnknownFields: true });
    // ProtoJSON also accepts numeric strings and non-finite double spellings.
    // HTTP's existing contract requires finite JSON numbers and populated keys.
    const input = raw as Record<string, unknown>;
    for (const key of ['wickNumber', 'year', 'day', 'startsAt', 'nextTurning', 'wickDays'] as const) {
      if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) throw new Error('invalid calendar number');
    }
    if (!day.wick || !day.mark || day.day < 1 || day.wickDays < 1) throw new Error('invalid calendar');
    const { $typeName, $unknown, ...fields } = day;
    return { ...fields, festival: day.festival ?? null, notice: day.notice ?? null };
  } catch {
    throw new ApiError('bad-response');
  }
}
