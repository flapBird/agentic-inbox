import { randomBytes } from "node:crypto";
import { hashPassword } from "../workers/lib/auth-crypto";

async function passwordPrompt(label: string): Promise<string> {
	if (!process.stdin.isTTY) throw new Error("Run in an interactive terminal; passwords are not accepted as command-line arguments.");
	process.stdout.write(label);
	process.stdin.setRawMode(true);
	process.stdin.setEncoding("utf8");
	process.stdin.resume();
	return new Promise((resolve, reject) => {
		let value = "";
		const finish = () => { process.stdin.off("data", onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n"); };
		const onData = (data: string) => {
			for (const char of data) {
				if (char === "\u0003") { finish(); reject(new Error("Cancelled")); return; }
				if (char === "\r" || char === "\n") { finish(); resolve(value); return; }
				if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
				else if (char >= " ") value += char;
			}
		};
		process.stdin.on("data", onData);
	});
}

try {
	if (process.argv[2] === "api-key") {
		const senders = process.argv.slice(3);
		if (!senders.length || senders.some((sender) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender))) throw new Error("Usage: npm run auth:api-key -- hello@example.com [other@example.com]");
		console.log("Save this JSON as the SEND_API_KEYS Worker secret. Keep existing entries when adding a website:");
		console.log(JSON.stringify([{ name: "my-website", key: randomBytes(32).toString("hex"), from: senders }], null, 2));
	} else {
		const password = await passwordPrompt("Admin password (6–1024 characters, hidden): ");
		if (password.length < 6 || password.length > 1024) throw new Error("Use a password between 6 and 1024 characters.");
		if (password !== await passwordPrompt("Confirm password: ")) throw new Error("Passwords do not match.");
		console.log("Store these values as Worker secrets (do not commit them):");
		console.log(`ADMIN_PASSWORD_HASH=${await hashPassword(password, randomBytes(16).toString("hex"))}`);
		console.log(`SESSION_SECRET=${randomBytes(32).toString("hex")}`);
	}
} catch (error) {
	console.error((error as Error).message);
	process.exitCode = 1;
}
