import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Env } from '../types';
import { hashKey, managedKeys } from '../lib/managed-config';
export function createAdminConfig() {
 const app = new Hono<{Bindings: Env}>();
 app.use('*', async (c,next) => { if (!['GET','HEAD'].includes(c.req.method) && c.req.header('Origin') !== new URL(c.req.url).origin) return c.json({error:'Invalid request origin'},403); await next(); });
 app.use('*', bodyLimit({maxSize: 65536}));
 app.use('*', async (c,next) => { c.header('Cache-Control','no-store'); await next(); });
 app.get('/keys', async c => c.json((await managedKeys(c.env)).map(({hash,...key}) => key)));
 app.post('/keys', async c => {
  const parsed = z.object({name:z.string().trim().min(1).max(80),from:z.array(z.string().email()).min(1).max(100)}).safeParse(await c.req.json().catch(()=>null));
  if (!parsed.success) return c.json({error:'请输入名称和有效发件地址'},400);
  for (const address of parsed.data.from) if (!await c.env.BUCKET.head(`mailboxes/${address.toLowerCase()}.json`)) return c.json({error:'请先创建发件邮箱'},400);
  const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), b=>b.toString(16).padStart(2,'0')).join('');
  const record = {id:crypto.randomUUID(),name:parsed.data.name,from:parsed.data.from.map(s=>s.toLowerCase()),hash:await hashKey(key)};
  await c.env.BUCKET.put(`admin/keys/${record.id}.json`,JSON.stringify(record));
  return c.json({id:record.id,key},201);
 });
 app.delete('/keys/:id',async c => {
  if (!z.string().uuid().safeParse(c.req.param('id')).success) return c.json({error:'Invalid ID'},400);
  await c.env.BUCKET.delete(`admin/keys/${c.req.param('id')}.json`); return c.body(null,204);
 });
 return app;
}
