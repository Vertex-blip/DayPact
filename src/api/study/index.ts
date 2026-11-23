import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Identity } from '../types';
import { rateLimit } from '../security';
import { getStudyDocument, saveStudyDocument } from './repository';
import { studyWriteSchema } from './schema';

type Bindings = { Bindings: Env; Variables: { identity: Identity } };
export { studyDataSchema, studyWriteSchema, STUDY_MAX_BYTES } from './schema';
export { getStudyDocument, saveStudyDocument, studyDocument, type StudyRow } from './repository';
export { nextStudyReminder } from '../../shared/studyTime';

/** Mounted below the ordinary verified-identity / active-account middleware. */
export function createStudyApi() {
  const app = new Hono<Bindings>();
  app.use('/study', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    z.object({}).strict().parse(c.req.query());
    await next();
  });
  app.get('/study', async (c) =>
    c.json({ study: await getStudyDocument(c.env, c.get('identity').uid) }),
  );
  app.put('/study', async (c) => {
    const input = studyWriteSchema.parse(await c.req.json());
    const uid = c.get('identity').uid;
    await rateLimit(c.env, `study-edit:${uid}`, 30, 3600);
    return c.json({ study: await saveStudyDocument(c.env, uid, input.version, input.data) });
  });
  return app;
}
