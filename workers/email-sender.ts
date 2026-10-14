// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared outbound email contract and provider selection.
 * Cloudflare remains the default for existing deployments.
 */

import { sendCloudflareEmail } from "./email-providers/cloudflare";
import { sendMailjetEmail } from "./email-providers/mailjet";

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
}

export interface EmailSenderEnv {
	EMAIL?: SendEmail;
	EMAIL_PROVIDER?: string;
	MAILJET_API_KEY?: string;
	MAILJET_SECRET_KEY?: string;
}

export class EmailSendError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = "EmailSendError";
		this.code = code;
	}
}

/** Send once through the configured provider; never retry or fall back automatically. */
export async function sendEmail(
	env: EmailSenderEnv,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	switch (env.EMAIL_PROVIDER ?? "cloudflare") {
		case "cloudflare":
			if (!env.EMAIL) {
				throw new EmailSendError("Cloudflare EMAIL binding is not configured", "EMAIL_CONFIG_ERROR");
			}
			return sendCloudflareEmail(env.EMAIL, params);
		case "mailjet":
			return sendMailjetEmail(env, params);
		default:
			throw new EmailSendError("EMAIL_PROVIDER must be cloudflare or mailjet", "EMAIL_CONFIG_ERROR");
	}
}
