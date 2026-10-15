const encoder = new TextEncoder();
export async function digest(value: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function equalSecret(a: string, b: string): Promise<boolean> {
	const [left, right] = await Promise.all([digest(a), digest(b)]);
	let difference = 0;
	for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
	return difference === 0;
}

export const PASSWORD_FORMAT = /^pbkdf2-sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/;
export async function hashPassword(password: string, salt: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
	const bytes = new Uint8Array(await crypto.subtle.deriveBits({
		name: "PBKDF2", hash: "SHA-256", iterations: 100_000,
		salt: Uint8Array.from(salt.match(/../g)!, (pair) => parseInt(pair, 16)),
	}, key, 256));
	return `pbkdf2-sha256$100000$${salt}$${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
	if (!PASSWORD_FORMAT.test(encoded)) return false;
	return equalSecret(await hashPassword(password, encoded.split("$")[2]), encoded);
}
