// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { z } from "zod";
import { EmailSendError, type EmailSenderEnv, type SendEmailParams } from "../email-sender";

const recipientResult = z.object({ MessageUUID: z.string().min(1) });
const mailjetError = z.object({ ErrorCode: z.string().optional() });
const sendResponse = mailjetError.extend({
	Messages: z.array(z.object({
		Status: z.string(),
		Errors: z.array(mailjetError).optional(),
		To: z.array(recipientResult).optional(),
		Cc: z.array(recipientResult).optional(),
		Bcc: z.array(recipientResult).optional(),
	})).optional(),
});

function address(value: NonNullable<SendEmailParams["replyTo"]>) {
	return typeof value === "string" ? { Email: value } : { Email: value.email, Name: value.name };
}

function recipients(value: string | string[]) {
	return (Array.isArray(value) ? value : [value]).map((Email) => ({ Email }));
}

// Only emit known diagnostic labels. Raw messages, stacks and causes can contain
// credentials, request headers or email content, even when thrown by fetch.
function failureDetails(error: unknown) {
	const value = error instanceof Error ? error : undefined;
	const cause = value?.cause;
	const code = cause && typeof cause === "object" && "code" in cause
		? cause.code : value && "code" in value ? value.code : undefined;
	const knownCodes = ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"];
	const errorCode = typeof code === "string" && knownCodes.includes(code) ? code : "UNKNOWN";
	const errorType = value && ["Error", "TypeError", "TimeoutError", "AbortError", "InvalidCharacterError"].includes(value.name)
		? value.name : "UnknownError";
	return { errorType, errorCode };
}

/** Mailjet Send API v3.1. The returned UUID is a provider ID, not an SMTP Message-ID. */
export async function sendMailjetEmail(
	env: Pick<EmailSenderEnv, "MAILJET_API_KEY" | "MAILJET_SECRET_KEY">,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	const apiKey = env.MAILJET_API_KEY?.trim();
	const secretKey = env.MAILJET_SECRET_KEY?.trim();
	if (!apiKey || !secretKey) {
		throw new EmailSendError("Mailjet requires MAILJET_API_KEY and MAILJET_SECRET_KEY secrets", "EMAIL_CONFIG_ERROR");
	}

	const message: Record<string, unknown> = {
		From: address(params.from),
		To: recipients(params.to),
		Subject: params.subject,
	};
	if (params.html) message.HTMLPart = params.html;
	if (params.text) message.TextPart = params.text;
	if (params.cc) message.Cc = recipients(params.cc);
	if (params.bcc) message.Bcc = recipients(params.bcc);
	if (params.replyTo) message.ReplyTo = address(params.replyTo);
	if (params.headers && Object.keys(params.headers).length > 0) message.Headers = params.headers;

	for (const disposition of ["attachment", "inline"] as const) {
		const attachments = params.attachments?.filter((attachment) => attachment.disposition === disposition);
		if (attachments?.length) {
			message[disposition === "inline" ? "InlinedAttachments" : "Attachments"] = attachments.map((attachment) => ({
				ContentType: attachment.type,
				Filename: attachment.filename,
				Base64Content: attachment.content,
				...(disposition === "inline" && attachment.contentId ? { ContentID: attachment.contentId } : {}),
			}));
		}
	}

	let response: Response;
	const startedAt = Date.now();
	let stage: "prepare_request" | "fetch" = "prepare_request";
	try {
		const init: RequestInit = {
			method: "POST",
			headers: {
				Authorization: `Basic ${btoa(`${apiKey}:${secretKey}`)}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ Messages: [message] }),
			signal: AbortSignal.timeout(25_000),
			redirect: "error",
		};
		stage = "fetch";
		response = await fetch("https://api.mailjet.com/v3.1/send", init);
	} catch (error) {
		console.error("mailjet_send_failed", {
			provider: "mailjet",
			stage,
			elapsedMs: Date.now() - startedAt,
			timeoutMs: 25_000,
			...failureDetails(error),
		});
		// A failed/timeout request may already have been accepted. Do not retry it here.
		throw new EmailSendError("Mailjet request failed or timed out; delivery is unconfirmed. Check Mailjet activity before retrying.", "MAILJET_NETWORK_ERROR");
	}

	const parsed = sendResponse.safeParse(await response.json().catch(() => null));
	const result = parsed.success ? parsed.data : undefined;
	const sent = result?.Messages?.[0];
	if (response.ok && (result?.Messages?.length !== 1 || !sent || !["success", "error"].includes(sent.Status))) {
		throw new EmailSendError("Mailjet returned an unexpected response; delivery is unconfirmed. Check Mailjet activity before retrying.", "MAILJET_INVALID_RESPONSE");
	}
	if (!response.ok || sent?.Status !== "success") {
		const code = sent?.Errors?.[0]?.ErrorCode || result?.ErrorCode || `MAILJET_HTTP_${response.status}`;
		// Do not expose raw provider responses, which can contain email content or addresses.
		throw new EmailSendError(`Mailjet did not confirm sending (HTTP ${response.status}, ${code}). Check credentials, verified sender, quota and Mailjet activity.`, code);
	}
	const messageId = sent.To?.[0]?.MessageUUID || sent.Cc?.[0]?.MessageUUID || sent.Bcc?.[0]?.MessageUUID;
	if (!messageId) {
		throw new EmailSendError("Mailjet returned an unexpected response; delivery is unconfirmed. Check Mailjet activity before retrying.", "MAILJET_INVALID_RESPONSE");
	}
	return { messageId };
}
