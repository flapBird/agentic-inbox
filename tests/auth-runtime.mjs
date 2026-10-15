// Local workerd/SQLite smoke test. All credentials and storage are test-only.
// esbuild and miniflare are supplied by the locked Wrangler toolchain.
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { pbkdf2Sync } from 'node:crypto';
import assert from 'node:assert/strict';
const salt = '00112233445566778899aabbccddeeff';
const password = 'runtime-only-test-password';
const hash = `pbkdf2-sha256$100000$${salt}$${pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex')}`;
const result = await build({stdin:{ contents:`
import { Hono } from 'hono';
import { createAuthRoutes, requireAdmin } from './workers/lib/auth';
export { MailboxDO } from './workers/durableObject';
const app = new Hono();
app.route('/auth', createAuthRoutes());
app.use('*', requireAdmin());
app.get('/', c => c.text('private inbox'));
export default {fetch: app.fetch};
`, resolveDir:process.cwd(), sourcefile:'auth-runtime-smoke.ts',loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers'],target:'es2022'});
const mf = new Miniflare({ modules:true, script:result.outputFiles[0].text, compatibilityDate:'2025-11-28', compatibilityFlags:['nodejs_compat'], durableObjects:{ MAILBOX:{className:'MailboxDO',useSQLite:true} }, bindings:{AUTH_MODE:'password', ADMIN_USERNAME:'admin',ADMIN_PASSWORD_HASH:hash,SESSION_SECRET:'runtime-test-session-secret-0123456789abcdef'} });
try {
 const login = await mf.dispatchFetch('https://inbox.example.com/auth/login',{method:'POST',redirect:'manual',headers:{Origin:'https://inbox.example.com','Content-Type':'application/x-www-form-urlencoded','CF-Connecting-IP':'192.0.2.1'},body:new URLSearchParams({username:'admin',password})});
 assert.equal(login.status,303,await login.text());
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const privatePage=await mf.dispatchFetch('https://inbox.example.com/',{headers:{Cookie:cookie}});
 assert.equal(privatePage.status,200);
 assert.equal(await privatePage.text(),'private inbox');
 const requests=await Promise.all(Array.from({length:12},()=>mf.dispatchFetch('https://inbox.example.com/auth/login',{method:'POST',redirect:'manual',headers:{Origin:'https://inbox.example.com','Content-Type':'application/x-www-form-urlencoded','CF-Connecting-IP':'192.0.2.2'},body:new URLSearchParams({username:'admin',password:'wrong'})})));
 assert.equal(requests.filter(r=>r.status===401).length,10);
 assert.equal(requests.filter(r=>r.status===429).length,2);
 console.log('Workers runtime smoke passed: PBKDF2 login, secure session and concurrent SQLite-backed login limiting.');
} finally {await mf.dispose();}
