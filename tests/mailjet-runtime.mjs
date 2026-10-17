// Real Workers request validation with a local stub: no email or external requests.
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import assert from 'node:assert/strict';

const result = await build({
  stdin: { contents: `
    import { sendMailjetEmail } from './workers/email-providers/mailjet';
    export default { async fetch() {
      try {
        return Response.json(await sendMailjetEmail(
          { MAILJET_API_KEY: 'runtime-key', MAILJET_SECRET_KEY: 'runtime-secret' },
          { from: 'sender@example.com', to: 'recipient@example.net', subject: 'Runtime test', text: 'Test' }
        ));
      } catch (error) { return Response.json({ code: error.code }, { status: 502 }); }
    }};
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
});
let status = 200;
let calls = 0;
const mf = new Miniflare({
  modules: true, script: result.outputFiles[0].text,
  compatibilityDate: '2025-11-28', compatibilityFlags: ['nodejs_compat'],
  outboundService: async (request) => {
    calls++;
    assert.equal(request.url, 'https://api.mailjet.com/v3.1/send');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('Authorization'), `Basic ${btoa('runtime-key:runtime-secret')}`);
    assert.equal((await request.json()).Messages[0].Subject, 'Runtime test');
    return status === 200
      ? Response.json({ Messages: [{ Status: 'success', To: [{ MessageUUID: 'runtime-uuid' }] }] })
      : new Response(null, { status, headers: { Location: 'https://unexpected.example/collect' } });
  },
});
try {
  const success = await mf.dispatchFetch('https://inbox.example.com');
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { messageId: 'runtime-uuid' });
  assert.equal(calls, 1);
  for (status of [301, 302, 303, 307, 308]) {
    const before = calls;
    const rejected = await mf.dispatchFetch('https://inbox.example.com');
    assert.equal(rejected.status, 502);
    assert.deepEqual(await rejected.json(), { code: `MAILJET_HTTP_${status}` });
    assert.equal(calls, before + 1, 'Redirects must not be followed or retried');
  }
  console.log('Mailjet Workers runtime passed: successful send and rejection of all redirect statuses without following.');
} finally { await mf.dispose(); }
