// 실행 어댑터 이벤트의 공통 형식만 검증한다.
import { z } from 'zod';

export const adapterEventTypeSchema = z.enum([
  'step-started',
  'case-result',
  'evidence-created',
  'resource-intent',
  'resource-created',
  'resource-cleaned',
  'step-finished',
  'worker-finished',
]);

const utcTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19);
  });

export const adapterEventSchema = z.strictObject({
  protocolVersion: z.literal(1),
  runId: z.uuid(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  type: adapterEventTypeSchema,
  time: utcTimeSchema,
  payload: z.record(z.string(), z.unknown()),
});

export type AdapterEvent = z.infer<typeof adapterEventSchema>;
