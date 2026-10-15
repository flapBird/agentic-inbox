import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { Hono } from "hono";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { createAuthRoutes, createSession, requireAdmin, validSession } from "../workers/lib/auth";
import { hashPassword } from "../workers/lib/auth-crypto";
import { createSendApi } from "../workers/routes/send-api";
import type { Env } from "../workers/types";

const password = "correct password for testing";
const passwordHash = await hashPassword(password, "00112233445566778899aabbccddeeff");
const apiKey = "a".repeat(64);
const base = "https://inbox.example.com";
function fixture() {
	const counters = new Map<string, number>();
	const saved = mock.fn(async () => {});
	const delivered = mock.fn(async () => ({ messageId: "cf-id" }));
	const env = {
		AUTH_MODE: "password", ADMIN_USERNAME: "admin", ADMIN_PASSWORD_HASH: passwordHash, SESSION_SECRET: "s".repeat(64),
		SEND_API_KEYS: JSON.stringify([{ name: "site-a", key: apiKey, from: ["hello@example.com"] }]),
		EMAIL_PROVIDER: "cloudflare", EMAIL: { send: delivered },
		BUCKET: { head: async () => ({}), put: async () => {} },
		MAILBOX: { idFromName: (name: string) => name, get: (name: string) => ({
			consumeRequestLimit: async (limit: number) => { const count = (counters.get(name) ?? 0) + 1; counters.set(name, count); return count <= limit; },
			checkSendRateLimit: async () => null, createEmail: saved,
		}) },
	} as unknown as Env;
	const app = new Hono<{ Bindings: Env }>();
	app.route("/auth", createAuthRoutes());
	app.route("/api/v1/send", createSendApi());
	app.use("*", requireAdmin());
	app.all("*", (c) => c.json({ admin: true }));
	return { env, app, saved, delivered, counters };
}
const payload = { from: "hello@example.com", to: "recipient@example.net", subject: "Test", text: "Hello" };
function sendRequest(app: ReturnType<typeof fixture>["app"], env: Env, body: unknown = payload, headers: Record<string, string> = {}) {
	return app.request(`${base}/api/v1/send`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }, env);
}
afterEach(() => mock.restoreAll());

test("password login returns a secure session, protects admin and supports logout", async () => {
	const { env, app } = fixture();
	const denied = await app.request(base, {}, env);
	assert.equal(denied.status, 302);
	assert.equal(denied.headers.get("Location"), "/auth/login");
	const page = await app.request(`${base}/auth/login`, {}, env);
	assert.match(await page.text(), /autocomplete="current-password"/);
	const login = await app.request(`${base}/auth/login`, { method: "POST", headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: "admin", password }) }, env);
	assert.equal(login.status, 303);
	const cookie = login.headers.get("Set-Cookie")!;
	for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=43200"]) assert.ok(cookie.includes(flag));
	const sessionCookie = cookie.split(";")[0];
	assert.equal((await app.request(`${base}/api/v1/config`, { headers: { Cookie: sessionCookie } }, env)).status, 200);
	assert.equal((await app.request(`${base}/auth/logout`, { method: "POST", headers: { Cookie: sessionCookie, Origin: base } }, env)).status, 303);
	const logout = await app.request(`${base}/auth/logout`, { method: "POST", headers: { Cookie: sessionCookie, Origin: base } }, env);
	assert.match(logout.headers.get("Set-Cookie")!, /Max-Age=0/);
});

test("invalid password and username use the same error; repeated attempts are limited", async () => {
	const { env, app } = fixture();
	for (let i = 0; i < 11; i++) {
		const response = await app.request(`${base}/auth/login`, { method: "POST", headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: i % 2 ? "wrong" : "admin", password: "wrong" }) }, env);
		assert.equal(response.status, i === 10 ? 429 : 401);
		assert.equal(response.headers.get("Set-Cookie"), null);
	}
});

test("password auth rejects forged, expired and password-rotation sessions", async () => {
	const { env } = fixture();
	const token = await createSession(env);
	assert.equal(await validSession(env, token), true);
	assert.equal(await validSession(env, `${token}x`), false);
	assert.equal(await validSession({ ...env, ADMIN_USERNAME: "changed" }, token), false);
	assert.equal(await validSession({ ...env, ADMIN_PASSWORD_HASH: await hashPassword("different password", "00112233445566778899aabbccddeeff") }, token), false);
	assert.equal(await validSession({ ...env, SESSION_SECRET: "z".repeat(64) }, token), false);
	const expired = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("agentic-inbox").setAudience("inbox-admin").setIssuedAt(1).setExpirationTime(2).sign(new TextEncoder().encode(env.SESSION_SECRET!));
	assert.equal(await validSession(env, expired), false);
});

test("CSRF and cross-origin WebSockets are blocked, same-origin operations work", async () => {
	const { env, app } = fixture();
	const cookie = `__Host-inbox_session=${await createSession(env)}`;
	for (const path of ["/auth/login", "/auth/logout", "/api/v1/mailboxes"]) {
		assert.equal((await app.request(`${base}${path}`, { method: "POST", headers: { Cookie: cookie, Origin: "https://evil.example.com" } }, env)).status, 403);
	}
	assert.equal((await app.request(`${base}/agents/test`, { headers: { Cookie: cookie, Upgrade: "websocket", Origin: "https://evil.example.com" } }, env)).status, 403);
	assert.equal((await app.request(`${base}/agents/test`, { headers: { Cookie: cookie, Upgrade: "websocket", Origin: base } }, env)).status, 200);
	assert.equal((await app.request(`${base}/api/v1/mailboxes`, { method: "POST", headers: { Cookie: cookie, Origin: base } }, env)).status, 200);
});

test("missing auth configuration and invalid modes fail closed; Access stays default", async () => {
	const { env, app } = fixture();
	for (const changes of [{ SESSION_SECRET: undefined }, { ADMIN_PASSWORD_HASH: "bad" }, { AUTH_MODE: "none" }, { AUTH_MODE: undefined }]) {
		assert.equal((await app.request(base, {}, { ...env, ...changes })).status, 503);
	}
	const accessEnv = { ...env, AUTH_MODE: "access", POLICY_AUD: "aud", TEAM_DOMAIN: "https://team.cloudflareaccess.com" };
	assert.equal((await app.request(base, {}, accessEnv)).status, 403);
	const dev = new Hono<{ Bindings: Env }>().use("*", requireAdmin(true)).get("/", (c) => c.text("ok"));
	assert.equal((await dev.request(base, {}, { ...env, AUTH_MODE: undefined })).status, 200);
	assert.equal((await dev.request(base, {}, env)).status, 302);
});

for (const provider of ["cloudflare", "mailjet"]) {
	test(`website key sends through ${provider} and records the message in Sent`, async () => {
		const { env, app, saved, delivered } = fixture();
		Object.assign(env, { EMAIL_PROVIDER: provider, MAILJET_API_KEY: "test-key", MAILJET_SECRET_KEY: "test-secret" });
		const network = mock.method(globalThis, "fetch", async () => Response.json({ Messages: [{ Status: "success", To: [{ MessageUUID: "mailjet-id" }] }] }));
		const response = await sendRequest(app, env);
		assert.equal(response.status, 202, await response.clone().text());
		assert.equal((await response.json() as any).status, "sent");
		assert.equal(saved.mock.callCount(), 1);
		assert.equal(delivered.mock.callCount(), provider === "cloudflare" ? 1 : 0);
		assert.equal(network.mock.callCount(), provider === "mailjet" ? 1 : 0);
	});
}

test("API keys cannot read inboxes, use MCP, or escalate to admin", async () => {
	const { env, app } = fixture();
	for (const path of ["/api/v1/mailboxes", "/api/v1/config", "/mcp", "/agents/test"]) {
		assert.equal((await app.request(`${base}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } }, env)).status, 401);
	}
});

test("API rejects unknown keys, sender escalation, malformed JSON and browser requests before delivery", async () => {
	const { env, app, saved, delivered } = fixture();
	assert.equal((await sendRequest(app, env, payload, { Authorization: "Bearer wrong" })).status, 401);
	assert.equal((await sendRequest(app, env, { ...payload, from: "other@example.com" })).status, 403);
	assert.equal((await sendRequest(app, env, { ...payload, from: { email: "other@example.com", name: "spoof" } })).status, 403);
	assert.equal((await sendRequest(app, env, {})).status, 400);
	assert.equal((await app.request(`${base}/api/v1/send`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: "{" }, env)).status, 400);
	assert.equal((await sendRequest(app, env, payload, { Origin: base })).status, 403);
	assert.equal((await app.request(`${base}/api/v1/send`, { headers: { Authorization: `Bearer ${apiKey}` } }, env)).status, 405);
	assert.equal(delivered.mock.callCount(), 0);
	assert.equal(saved.mock.callCount(), 0);
});

test("revoked/disabled keys and API rate limits fail closed", async () => {
	const { env, app, delivered, counters } = fixture();
	assert.equal((await sendRequest(app, { ...env, SEND_API_KEYS: undefined })).status, 503);
	assert.equal((await sendRequest(app, { ...env, SEND_API_KEYS: "bad" })).status, 503);
	const rotated = JSON.stringify([{ name: "site-a", key: "b".repeat(64), from: ["hello@example.com"] }]);
	assert.equal((await sendRequest(app, { ...env, SEND_API_KEYS: rotated })).status, 401);
	await sendRequest(app, env);
	for (const entry of counters.keys()) counters.set(entry, 60);
	assert.equal((await sendRequest(app, env)).status, 429);
	assert.equal(delivered.mock.callCount(), 1);
});

test("provider failures are surfaced to websites and not saved as sent", async () => {
	const { env, app, saved } = fixture();
	mock.method(console, "error", () => {});
	env.EMAIL = { send: async () => { throw new Error("rejected"); } } as never;
	assert.equal((await sendRequest(app, env)).status, 502);
	assert.equal(saved.mock.callCount(), 0);
});


test("Access mode still validates issuer, audience and signature with base or certs URLs", async () => {
	const { env, app } = fixture();
	const { privateKey, publicKey } = await generateKeyPair("RS256");
	const jwk = { ...await exportJWK(publicKey), kid: "test", alg: "RS256", use: "sig" };
	mock.method(globalThis, "fetch", async () => Response.json({ keys: [jwk] }));
	const sign = (audience: string) => new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer("https://team.cloudflareaccess.com").setAudience(audience).setExpirationTime("5m").sign(privateKey);
	for (const suffix of ["", "/cdn-cgi/access/certs"]) {
		const access = { ...env, AUTH_MODE: "access", POLICY_AUD: "aud", TEAM_DOMAIN: `https://team.cloudflareaccess.com${suffix}` };
		assert.equal((await app.request(base, { headers: { "cf-access-jwt-assertion": await sign("aud") } }, access)).status, 200);
		assert.equal((await app.request(base, { headers: { "cf-access-jwt-assertion": await sign("wrong") } }, access)).status, 403);
	}
});

test("login rejects missing Origin, HTTP and oversized input", async () => {
	mock.method(console, "error", () => {});
	const { env, app } = fixture();
	assert.equal((await app.request(`${base}/auth/login`, { method: "POST" }, env)).status, 403);
	assert.equal((await app.request("http://inbox.example.com/auth/login", {}, env)).status, 400);
	assert.equal((await app.request(`${base}/auth/login`, { method: "POST", headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" }, body: "password=" + "x".repeat(5000) }, env)).status, 413);
});

test("send API cannot use an absent mailbox and respects request size limits", async () => {
	mock.method(console, "error", () => {});
	const { env, app, delivered } = fixture();
	(env.BUCKET as any).head = async () => null;
	assert.equal((await sendRequest(app, env)).status, 404);
	assert.equal(delivered.mock.callCount(), 0);
	const response = await app.request(`${base}/api/v1/send`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, text: "x".repeat(20 * 1024 * 1024) }) }, env);
	assert.equal(response.status, 413);
});
