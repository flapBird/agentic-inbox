// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export type Env = Cloudflare.Env & {
	AUTH_MODE?: string;
	ADMIN_USERNAME?: string;
	ADMIN_PASSWORD_HASH?: string;
	SESSION_SECRET?: string;
	SEND_API_KEYS?: string;
	POLICY_AUD?: string;
	TEAM_DOMAIN?: string;
};
