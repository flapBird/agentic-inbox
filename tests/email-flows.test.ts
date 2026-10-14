import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { app } from "../workers/index";
import { toolSendEmail, toolSendReply } from "../workers/lib/tools";
import type { Env } from "../workers/types";

afterEach(() => mock.restoreAll());

function fixture(accepted: boolean, provider = "mailjet") {
	const events: string[] = [];
	const messages: any[] = [];
	const send = async (message: unknown) => {
		events.push("send");
		messages.push(message);
		if (!accepted) throw new Error("Provider rejected email");
		return { messageId: "cf-id" };
	};
	mock.method(globalThis, "fetch", async (_url, init) => {
		events.push("send");
		messages.push(JSON.parse(init?.body as string).Messages[0]);
		return Response.json({ Messages: [accepted
			? { Status: "success", To: [{ MessageUUID: "mailjet-id" }] }
			: { Status: "error", Errors: [{ ErrorCode: "send-0008" }] }] });
	});
	mock.method(console, "error", () => {});
	const stub = {
		checkSendRateLimit: async () => null,
		getEmail: async () => ({
			id: "original", message_id: "original@example.net", thread_id: "thread", folder_id: "inbox",
			sender: "recipient@example.net", subject: "Hello", body: "Original", date: "2026-01-01T00:00:00Z",
		}),
		createEmail: mock.fn(async () => { events.push("save"); }),
		markThreadRead: mock.fn(async () => { events.push("read"); }),
	};
	const env = {
		EMAIL_PROVIDER: provider, MAILJET_API_KEY: "test-key", MAILJET_SECRET_KEY: "test-secret",
		...(provider === "cloudflare" ? { EMAIL: { send } } : {}),
		BUCKET: { head: async () => ({}), put: mock.fn(async () => { events.push("attachment"); }) },
		MAILBOX: { idFromName: (name: string) => name, get: () => stub },
	} as unknown as Env;
	return { env, events, messages, stub };
}

for (const provider of ["mailjet", "cloudflare"]) {
	for (const action of ["", "/original/reply", "/original/forward"]) {
		for (const accepted of [true, false]) {
			test(`${provider} web ${action || "compose"}: ${accepted ? "accept before saving" : "reject without saving Sent"}`, async () => {
				const { env, events, stub, messages } = fixture(accepted, provider);
				const response = await app.request(`https://inbox.example.com/api/v1/mailboxes/sender@example.com/emails${action}`, {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						from: "sender@example.com", to: "recipient@example.net", subject: "Hello", text: "Test",
						attachments: [{ content: "aGk=", filename: "hi.txt", type: "text/plain", disposition: "attachment" }],
					}),
				}, env);
				assert.equal(response.status, accepted ? 202 : 502);
				const result = await response.json() as any;
				if (accepted) {
					assert.equal(result.status, "sent");
					assert.deepEqual(events, ["send", "attachment", "save", ...(action.endsWith("reply") ? ["read"] : [])]);
					assert.equal(stub.createEmail.mock.callCount(), 1);
				} else {
					assert.ok(result.error);
					assert.deepEqual(events, ["send"]);
					assert.equal(stub.createEmail.mock.callCount(), 0);
				}
				if (action.endsWith("reply")) {
					const headers = provider === "mailjet" ? messages[0].Headers : messages[0].headers;
					assert.equal(headers["In-Reply-To"], "<original@example.net>");
					assert.equal(headers.References, "<original@example.net>");
				}
			});
		}
	}
}

for (const reply of [false, true]) {
	for (const accepted of [true, false]) {
		test(`AI/MCP ${reply ? "reply" : "send"} uses Mailjet and ${accepted ? "saves accepted mail" : "reports failure"}`, async () => {
			const { env, events, messages } = fixture(accepted);
			const params = { to: "recipient@example.net", subject: "Hello", bodyHtml: "<p>Thanks</p>" };
			const result = reply
				? await toolSendReply(env, "sender@example.com", { ...params, originalEmailId: "original" })
				: await toolSendEmail(env, "sender@example.com", params);
			if (accepted) {
				assert.equal((result as any).status, "sent");
				assert.deepEqual(events, ["send", "save"]);
			} else {
				assert.match((result as any).error, /Failed to send/);
				assert.deepEqual(events, ["send"]);
			}
			if (reply) assert.equal(messages[0].Headers["In-Reply-To"], "<original@example.net>");
		});
	}
}
