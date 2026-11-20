import { z } from 'zod';
import { validDate, validZone } from './dates';
export const dateSchema = z.string().refine(validDate, 'Invalid calendar date');
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const uidSchema = z.string().min(1).max(128);
export const idSchema = z.string().uuid();
export const placeSchema = z
  .object({
    lat: z.number().min(-85.051129).max(85.051129),
    lng: z.number().min(-180).max(180),
    label: z.string().trim().min(1).max(200),
  })
  .strict();
export const profileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(70),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_]{3,24}$/),
    bio: z.string().trim().max(300),
    city: z.string().trim().max(80),
  })
  .strict();
export const settingsSchema = z
  .object({
    locale: z.enum(['kk', 'ru']),
    theme: z.enum(['system', 'dark', 'light']),
    notificationsEnabled: z.boolean(),
    friendNudges: z.boolean(),
    quietStart: timeSchema,
    quietEnd: timeSchema,
    timeZone: z.string().refine(validZone, 'Invalid time zone'),
  })
  .strict();
const planFields = {
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  kind: z.enum(['habit', 'event', 'savings']),
  cadence: z.enum(['once', 'daily', 'weekly', 'monthly']),
  startDate: dateSchema,
  time: timeSchema,
  timeZone: z.string().refine(validZone).optional(),
  memberIds: z
    .array(uidSchema)
    .max(20)
    .refine((a) => new Set(a).size === a.length, 'Duplicate member'),
  place: placeSchema.nullable().optional(),
  targetAmount: z.number().int().positive().max(1000000000).nullable().optional(),
  remindMinutes: z.number().int().min(-1).max(10080),
  minAttendees: z.number().int().min(2).max(21).nullable().optional(),
};
export const planSchema = z
  .object(planFields)
  .strict()
  .refine((p) => p.kind !== 'savings' || Boolean(p.targetAmount), 'Savings target required');
export const planPatchSchema = z
  .object({ ...planFields, version: z.number().int().positive() })
  .partial()
  .extend({ version: z.number().int().positive() })
  .strict();
export const checkinSchema = z
  .object({
    date: dateSchema,
    completed: z.boolean(),
    contribution: z.number().int().min(0).max(1000000000).optional(),
    operationId: idSchema,
  })
  .strict();
export const rsvpSchema = z
  .object({
    date: dateSchema,
    status: z.enum(['accepted', 'declined']),
    version: z.number().int().positive().optional(),
  })
  .strict();
export const meetingPlaceSchema = z.object({ operationId: idSchema, place: placeSchema }).strict();
export const meetingVoteSchema = z.object({ optionId: idSchema.nullable() }).strict();
export const meetingConfirmSchema = z
  .object({ optionId: idSchema, version: z.number().int().positive() })
  .strict();
export const nudgeSchema = z.object({ toUserId: uidSchema, date: dateSchema }).strict();
export const invitationSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const pushSchema = z
  .object({ token: z.string().min(20).max(4096), deviceId: idSchema })
  .strict();
export const emptySchema = z.object({}).strict();
