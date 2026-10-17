import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { sendEmail, type SendEmailParams } from "../workers/email-sender";

const env = { EMAIL_PROVIDER: "mailjet", MAILJET_API_KEY: "test-key", MAILJET_SECRET_KEY: "test-secret" };
const basic: SendEmailParams = { from: "sender@example.com", to: "recipient@example.net", subject: "Hello", text: "Test" };
const success = { Messages: [{ Status: "success", To: [{ MessageUUID: "provider-uuid", MessageID: 123 }] }] };

afterEach(() => mock.restoreAll());

test("Cloudflare is the default and preserves every original message field", async () => {
	const params: SendEmailParams = {
		...basic, from: { email: basic.from as string, name: "Sender" },
		to: ["one@example.net", "two@example.net"], cc: "cc@example.net", bcc: ["bcc@example.net"],
		html: "<b>Test</b>", replyTo: { email: "reply@example.com", name: "Reply" },
		headers: { "In-Reply-To": "<original@example.net>", References: "<original@example.net>" },
		attachments: [{ content: "aGk=", filename: "hi.txt", type: "text/plain", disposition: "attachment" },
			{ content: "aGk=", filename: "image.png", type: "image/png", disposition: "inline", contentId: "image" }],
	};
	const send = mock.fn(async (message: unknown) => { assert.deepEqual(message, params); return { messageId: "cf-id" }; });
	const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network call"); });
	for (const EMAIL_PROVIDER of [undefined, "cloudflare"]) {
		assert.deepEqual(await sendEmail({ EMAIL: { send } as never, EMAIL_PROVIDER }, params), { messageId: "cf-id" });
	}
	assert.equal(send.mock.callCount(), 2);
	assert.equal(fetch.mock.callCount(), 0);
});

test("Mailjet maps the complete message and uses Basic auth without requiring EMAIL", async () => {
	const fetch = mock.method(globalThis, "fetch", async (url, init) => {
		assert.equal(url, "https://api.mailjet.com/v3.1/send");
		assert.equal(init?.method, "POST");
		assert.equal(init?.redirect, "manual");
		assert.ok(init?.signal instanceof AbortSignal);
		assert.deepEqual(init?.headers, { Authorization: `Basic ${btoa("test-key:test-secret")}`, "Content-Type": "application/json" });
		assert.deepEqual(JSON.parse(init?.body as string), { Messages: [{
			From: { Email: "sender@example.com", Name: "发件人" },
			To: [{ Email: "one@example.net" }, { Email: "two@example.net" }],
			Cc: [{ Email: "cc@example.net" }], Bcc: [{ Email: "bcc@example.net" }],
			ReplyTo: { Email: "reply@example.com", Name: "Reply" }, Subject: "Hello", HTMLPart: "<img src='cid:logo'>", TextPart: "Test",
			Headers: { "In-Reply-To": "<original@example.net>", References: "<original@example.net>" },
			Attachments: [{ ContentType: "text/plain", Filename: "hi.txt", Base64Content: "aGk=" }],
			InlinedAttachments: [{ ContentType: "image/png", Filename: "logo.png", Base64Content: "aGk=", ContentID: "logo" }],
		}] });
		return Response.json(success);
	});
	assert.deepEqual(await sendEmail(env, {
		...basic, from: { email: "sender@example.com", name: "发件人" }, to: ["one@example.net", "two@example.net"],
		cc: "cc@example.net", bcc: ["bcc@example.net"], replyTo: { email: "reply@example.com", name: "Reply" },
		html: "<img src='cid:logo'>", headers: { "In-Reply-To": "<original@example.net>", References: "<original@example.net>" },
		attachments: [{ content: "aGk=", filename: "hi.txt", type: "text/plain", disposition: "attachment" },
			{ content: "aGk=", filename: "logo.png", type: "image/png", disposition: "inline", contentId: "logo" }],
	}), { messageId: "provider-uuid" });
	assert.equal(fetch.mock.callCount(), 1);
});

test("Mailjet handles plain addresses and omits absent optional fields", async () => {
	mock.method(globalThis, "fetch", async (_url, init) => {
		assert.deepEqual(JSON.parse(init?.body as string), { Messages: [{
			From: { Email: "sender@example.com" }, To: [{ Email: "recipient@example.net" }],
			Subject: "Hello", TextPart: "Test", ReplyTo: { Email: "reply@example.com" },
		}] });
		return Response.json(success);
	});
	await sendEmail(env, { ...basic, replyTo: "reply@example.com", headers: {}, attachments: [] });
});

test("configuration errors never contact a provider", async () => {
	const fetch = mock.method(globalThis, "fetch", async () => Response.json(success));
	const send = mock.fn(async () => ({ messageId: "unexpected" }));
	for (const config of [{}, { EMAIL_PROVIDER: "unknown", EMAIL: { send } }, { EMAIL_PROVIDER: "" },
		{ ...env, MAILJET_API_KEY: "" }, { ...env, MAILJET_SECRET_KEY: "  " }]) {
		await assert.rejects(sendEmail(config as never, basic), { code: "EMAIL_CONFIG_ERROR" });
	}
	assert.equal(fetch.mock.callCount(), 0);
	assert.equal(send.mock.callCount(), 0);
});

for (const [name, status, body, code] of [
	["authentication", 401, { ErrorCode: "mj-0015" }, "mj-0015"],
	["quota", 429, {}, "MAILJET_HTTP_429"],
	["message rejection on HTTP 200", 200, { Messages: [{ Status: "error", Errors: [{ ErrorCode: "send-0008" }] }] }, "send-0008"],
	["missing provider ID", 200, { Messages: [{ Status: "success" }] }, "MAILJET_INVALID_RESPONSE"],
] as const) {
	test(`Mailjet rejects ${name} without falling back or retrying`, async () => {
		const fetch = mock.method(globalThis, "fetch", async () => Response.json(body, { status }));
		const send = mock.fn(async () => ({ messageId: "unexpected" }));
		await assert.rejects(sendEmail({ ...env, EMAIL: { send } as never }, basic), { code });
		assert.equal(fetch.mock.callCount(), 1);
		assert.equal(send.mock.callCount(), 0);
	});
}

test("Mailjet non-JSON and malformed success responses cannot count as sent", async () => {
	for (const response of [new Response("<html>bad gateway</html>", { status: 502 }), Response.json(null), Response.json({ Messages: [] })]) {
		mock.method(globalThis, "fetch", async () => response);
		await assert.rejects(sendEmail(env, basic));
		mock.restoreAll();
	}
});

test("network failures and timeouts report uncertainty without leaking keys or retrying", async () => {
	for (const cause of [new Error("test-secret"), new DOMException("timeout", "TimeoutError")]) {
		const fetch = mock.method(globalThis, "fetch", async () => { throw cause; });
		await assert.rejects(sendEmail(env, basic), (error: any) => {
			assert.equal(error.code, "MAILJET_NETWORK_ERROR");
			assert.match(error.message, /unconfirmed/);
			assert.doesNotMatch(error.message, /test-secret/);
			return true;
		});
		assert.equal(fetch.mock.callCount(), 1);
		mock.restoreAll();
	}
});

test("Cloudflare binding errors retain the original error and code", async () => {
	const error = Object.assign(new Error("Rejected"), { code: "CF_REJECTED" });
	await assert.rejects(sendEmail({ EMAIL: { send: async () => { throw error; } } as never }, basic), (actual) => actual === error);
});

test("Mailjet logs timing and known failure causes without logging sensitive exception data", async () => {
	const log = mock.method(console, "error", () => {});
	const sensitive = `${env.MAILJET_API_KEY} ${env.MAILJET_SECRET_KEY} ${basic.to} ${basic.text}`;
	const failures = [
		{ error: new TypeError(sensitive, { cause: Object.assign(new Error(sensitive), { code: "ENOTFOUND" }) }), type: "TypeError", code: "ENOTFOUND" },
		{ error: new DOMException(sensitive, "TimeoutError"), type: "TimeoutError", code: "UNKNOWN" },
		{ error: Object.assign(new Error(sensitive), { name: sensitive, code: sensitive }), type: "UnknownError", code: "UNKNOWN" },
		{ error: sensitive, type: "UnknownError", code: "UNKNOWN" },
	];
	let current: unknown;
	const fetch = mock.method(globalThis, "fetch", async () => { throw current; });
	for (const { error, type, code } of failures) {
		current = error;
		await assert.rejects(sendEmail(env, basic), { code: "MAILJET_NETWORK_ERROR" });
		const [event, details] = log.mock.calls.at(-1)!.arguments as unknown as [string, Record<string, unknown>];
		assert.equal(event, "mailjet_send_failed");
		assert.deepEqual(details, { provider: "mailjet", stage: "fetch", elapsedMs: details.elapsedMs, timeoutMs: 25_000, errorType: type, errorCode: code });
		assert.ok(typeof details.elapsedMs === "number" && details.elapsedMs >= 0);
		for (const privateValue of [env.MAILJET_API_KEY, env.MAILJET_SECRET_KEY, basic.to as string, basic.text!]) {
			assert.ok(!JSON.stringify(log.mock.calls).includes(privateValue));
		}
	}
	assert.equal(log.mock.callCount(), failures.length);
	assert.equal(fetch.mock.callCount(), failures.length);
});

test("Mailjet identifies credential encoding failures before contacting the provider", async () => {
	const log = mock.method(console, "error", () => {});
	const fetch = mock.method(globalThis, "fetch", async () => Response.json(success));
	await assert.rejects(sendEmail({ ...env, MAILJET_SECRET_KEY: "非拉丁字符" }, basic), { code: "MAILJET_NETWORK_ERROR" });
	const [, details] = log.mock.calls[0].arguments as unknown as [string, Record<string, unknown>];
	assert.equal(details.stage, "prepare_request");
	assert.equal(details.errorType, "InvalidCharacterError");
	assert.equal(fetch.mock.callCount(), 0);
	assert.ok(!JSON.stringify(log.mock.calls).includes("非拉丁字符"));
});
