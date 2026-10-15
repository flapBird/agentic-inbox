import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";
import type { Env } from "../types";
import { digest, equalSecret, PASSWORD_FORMAT, verifyPassword } from "./auth-crypto";
import { authPage } from "./auth-page";

const COOKIE = "__Host-inbox_session";
const TTL = 12 * 60 * 60;
const key = (value: string) => new TextEncoder().encode(value);
export function authMode(env: Env) { return env.AUTH_MODE ?? "access"; }
function configured(env: Env) {
	return !!env.ADMIN_USERNAME && PASSWORD_FORMAT.test(env.ADMIN_PASSWORD_HASH ?? "") && (env.SESSION_SECRET?.length ?? 0) >= 32;
}
async function version(env: Env) { return digest(`${env.ADMIN_USERNAME}\n${env.ADMIN_PASSWORD_HASH}`); }
export async function createSession(env: Env) {
	return new SignJWT({ version: await version(env) }).setProtectedHeader({ alg: "HS256" })
		.setSubject(env.ADMIN_USERNAME!).setIssuer("agentic-inbox").setAudience("inbox-admin")
		.setIssuedAt().setExpirationTime(`${TTL}s`).sign(key(env.SESSION_SECRET!));
}
export async function validSession(env: Env, token?: string) {
	if (!token || !configured(env)) return false;
	try {
		const { payload } = await jwtVerify(token, key(env.SESSION_SECRET!), { algorithms: ["HS256"], issuer: "agentic-inbox", audience: "inbox-admin", maxTokenAge: `${TTL}s` });
		return payload.sub === env.ADMIN_USERNAME && payload.version === await version(env);
	} catch { return false; }
}
export async function consumeLimit(env: Env, scope: string, limit: number, windowMs: number) {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(`__rate__:${await digest(scope)}`));
	return stub.consumeRequestLimit(limit, windowMs);
}

export function createAuthRoutes() {
	const app = new Hono<{ Bindings: Env }>();
	app.use("*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		// Same-origin HTML form POSTs must retain Origin for the CSRF check below.
		c.header("Referrer-Policy", "same-origin");
		c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
		if (authMode(c.env) !== "password") return c.notFound();
		if (!configured(c.env)) return c.text("Password login is not configured. Set ADMIN_USERNAME, ADMIN_PASSWORD_HASH and SESSION_SECRET.", 503);
		if (new URL(c.req.url).protocol !== "https:") return c.text("HTTPS is required for password login.", 400);
		if (c.req.method === "POST" && c.req.header("Origin") !== new URL(c.req.url).origin) return c.text("Invalid request origin", 403);
		return next();
	});
	app.use("*", bodyLimit({ maxSize: 4096 }));
	app.get("/login", async (c) => {
		if (await validSession(c.env, getCookie(c, COOKIE))) return c.redirect("/");
		return c.html(authPage());
	});
	app.post("/login", async (c) => {
		if (!await consumeLimit(c.env, `login:${c.req.header("CF-Connecting-IP") ?? "unknown"}`, 10, 15 * 60_000)) {
			c.header("Retry-After", "900");
			return c.html(authPage(false, "尝试次数过多，请 15 分钟后再试。"), 429);
		}
		const form = await c.req.parseBody();
		const username = typeof form.username === "string" ? form.username : "";
		const password = typeof form.password === "string" ? form.password : "";
		const passwordOK = await verifyPassword(password, c.env.ADMIN_PASSWORD_HASH!);
		if (!await equalSecret(username, c.env.ADMIN_USERNAME!) || !passwordOK) return c.html(authPage(false, "用户名或密码不正确。"), 401);
		setCookie(c, COOKIE, await createSession(c.env), { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: TTL });
		return c.redirect("/", 303);
	});
	app.get("/logout", (c) => c.html(authPage(true)));
	app.post("/logout", (c) => {
		deleteCookie(c, COOKIE, { secure: true, httpOnly: true, sameSite: "Strict", path: "/" });
		return c.redirect("/auth/login", 303);
	});
	return app;
}

export function requireAdmin(development = false) {
	return createMiddleware<{ Bindings: Env }>(async (c, next) => {
		// Keep the existing local development experience only when no mode was explicitly selected.
		if (development && !c.env.AUTH_MODE) return next();
		const mode = authMode(c.env);
		if (mode === "password") {
			c.header("Cache-Control", "no-store");
			if (!configured(c.env)) return c.json({ error: "Password login is not configured" }, 503);
			if (!await validSession(c.env, getCookie(c, COOKIE))) {
				if (c.req.method === "GET" && !/^\/(api|agents|mcp)(\/|$)/.test(c.req.path) && c.req.header("Upgrade") !== "websocket") return c.redirect("/auth/login");
				return c.json({ error: "Login required", loginUrl: "/auth/login" }, 401);
			}
			const origin = c.req.header("Origin");
			if ((!["GET", "HEAD", "OPTIONS"].includes(c.req.method) || c.req.header("Upgrade")?.toLowerCase() === "websocket") && origin !== new URL(c.req.url).origin) return c.json({ error: "Invalid request origin" }, 403);
			return next();
		}
		if (mode !== "access") return c.json({ error: "AUTH_MODE must be access or password" }, 503);
		if (!c.env.POLICY_AUD || !c.env.TEAM_DOMAIN) return c.text("Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN, or configure AUTH_MODE=password.", 503);
		const token = c.req.header("cf-access-jwt-assertion");
		if (!token) return c.text("Missing required CF Access JWT", 403);
		try {
			const team = new URL(c.env.TEAM_DOMAIN);
			const certs = team.pathname.endsWith("/cdn-cgi/access/certs") ? team : new URL("/cdn-cgi/access/certs", team);
			await jwtVerify(token, createRemoteJWKSet(certs), { issuer: team.origin, audience: c.env.POLICY_AUD });
		} catch { return c.text("Invalid or expired Access token", 403); }
		return next();
	});
}
