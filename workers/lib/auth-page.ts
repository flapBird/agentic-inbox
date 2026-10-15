import { html } from "hono/html";

export function authPage(logout = false, error = "") {
	return html`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${logout ? "退出登录" : "登录"} · Agentic Inbox</title>
<style>body{margin:0;background:#f5f6f8;color:#1c2533;font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh}main{box-sizing:border-box;width:min(420px,calc(100% - 32px));padding:36px;background:white;border:1px solid #e2e5e9;border-radius:18px}h1{font-size:24px;margin:0 0 12px}p{color:#596474;line-height:1.6}label{display:block;margin:20px 0 8px}input,button{box-sizing:border-box;width:100%;padding:12px;border-radius:8px;font:inherit}input{border:1px solid #abb4bf}button{margin-top:24px;background:#2563eb;color:white;border:0;cursor:pointer}a{display:block;margin-top:18px;color:#2563eb}input:focus,button:focus,a:focus{outline:3px solid #9dbbff;outline-offset:2px}.error{color:#b42318}</style></head><body><main><h1>Agentic Inbox</h1><p>${logout ? "退出当前浏览器的登录。" : "登录你的私人邮箱，管理收件与发件。"}</p>
${error ? html`<p class="error" role="alert">${error}</p>` : ""}
<form method="post" action="${logout ? "/auth/logout" : "/auth/login"}">
${logout ? "" : html`<label for="username">用户名</label><input id="username" name="username" autocomplete="username" required maxlength="128" autofocus><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024">`}
<button type="submit">${logout ? "退出登录" : "登录"}</button></form>${logout ? html`<a href="/">返回邮箱</a>` : ""}</main></body></html>`;
}
