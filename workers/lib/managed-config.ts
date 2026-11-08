import type { Env } from '../types';
export type ManagedKey = { id: string; name: string; hash: string; from: string[] };
export async function hashKey(key: string) {
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))), b => b.toString(16).padStart(2, '0')).join('');
}
export async function managedKeys(env: Env): Promise<ManagedKey[]> {
 let cursor: string | undefined;
 const objects: {key:string}[] = [];
 do { const page = await env.BUCKET.list({prefix:'admin/keys/',cursor}); objects.push(...page.objects); cursor=page.truncated?page.cursor:undefined; } while(cursor);
 const result = {objects};
 const keys = await Promise.all(result.objects.map(async o => (await env.BUCKET.get(o.key))?.json<ManagedKey>()));
 return keys.filter((k): k is ManagedKey => !!k);
}
