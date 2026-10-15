import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Env } from "../types";
import { app as mailboxApi } from "../index";
import { SendEmailRequestSchema } from "../lib/schemas";
import { equalSecret } from "../lib/auth-crypto";
import { consumeLimit } from "../lib/auth";

const keySchema = z.array(z.object({
	name: z.string().min(1).max(80),
	key: z.string().min(32).max(256),
	from: z.array(z.string().email()).min(1).max(100),
})).min(1).max(50).refine((keys) => new Set(keys.map((item) => item.key)).size === keys.length);
type ApiKey = z.infer<typeof keySchema>[number];

/** Server-to-server sending only. This key never authorizes inbox/admin/MCP access. */
export function createSendApi() {
	const app = new Hono<{ Bindings: Env; Variables: { sendKey: ApiKey } }>();
	app.use("*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		if (c.req.method !== "POST" || !["/api/v1/send", "/api/v1/send/", "/"].includes(c.req.path)) return c.json({ error: "Use POST /api/v1/send" }, 405);
		if (c.req.header("Origin")) return c.json({ error: "Call this endpoint from your website server, not the browser" }, 403);
		if (!c.env.SEND_API_KEYS) return c.json({ error: "Send API is not configured" }, 503);
		let keys: ApiKey[];
		try { keys = keySchema.parse(JSON.parse(c.env.SEND_API_KEYS)); }
		catch { return c.json({ error: "Invalid send API configuration" }, 503); }
		const authorization = c.req.header("Authorization") ?? "";
		const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
		if (token.length < 32 || token.length > 256) return c.json({ error: "Invalid API key" }, 401);
		let matched: ApiKey | undefined;
		for (const item of keys) if (await equalSecret(token, item.key)) matched = item;
		if (!matched) return c.json({ error: "Invalid API key" }, 401);
		if (!await consumeLimit(c.env, `send-key:${matched.key}`, 60, 60_000)) {
			c.header("Retry-After", "60");
			return c.json({ error: "API rate limit exceeded" }, 429);
		}
		c.set("sendKey", matched);
		return next();
	});
	app.use("*", bodyLimit({ maxSize: 20 * 1024 * 1024, onError: (c) => c.json({ error: "Request exceeds 20 MiB" }, 413) }));
	app.post("/", async (c) => {
		const parsed = SendEmailRequestSchema.safeParse(await c.req.json().catch((error) => {
			if (error instanceof SyntaxError) return null;
			throw error;
		}));
		if (!parsed.success) return c.json({ error: "Invalid email payload", details: parsed.error.flatten() }, 400);
		const body = parsed.data;
		const from = (typeof body.from === "string" ? body.from : body.from.email).toLowerCase();
		if (!c.var.sendKey.from.some((allowed) => allowed.toLowerCase() === from)) return c.json({ error: "API key is not allowed to use this sender" }, 403);
		// Reuse mailbox existence checks, sender validation, limits, delivery and Sent storage.
		const url = new URL(c.req.url);
		url.pathname = `/api/v1/mailboxes/${encodeURIComponent(from)}/emails`;
		url.search = "";
		return mailboxApi.fetch(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), c.env);
	});
	app.all("*", (c) => c.json({ error: "Not found" }, 404));
	return app;
}
