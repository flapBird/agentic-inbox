# 个人登录与网站发件 API

后台登录和网站发件使用两套独立凭证。个人模式不需要 Cloudflare Access / Zero Trust；收件、发件、附件和 AI 管理继续使用原来的后台。发件由 `EMAIL_PROVIDER=mailjet` 或 `cloudflare` 统一选择，网站不需要保存 Mailjet 密钥。

## 1. 设置个人账号

在本地运行：

```bash
npm run auth:password
```

按提示输入并确认至少 6 字符的密码（输入不回显）。脚本输出带随机盐的 `ADMIN_PASSWORD_HASH` 和随机 `SESSION_SECRET`，不保存明文密码。分别添加以下 Worker Secrets，也可以在 Cloudflare 控制台的 Worker → Settings → Variables and Secrets 中添加：

```bash
npx wrangler secret put AUTH_MODE
# 输入 password
npx wrangler secret put ADMIN_USERNAME
# 输入你的用户名，例如 admin
npx wrangler secret put ADMIN_PASSWORD_HASH
# 粘贴生成的哈希值，包含所有 $ 字符
npx wrangler secret put SESSION_SECRET
# 粘贴生成的会话密钥
npm run deploy
```

先完成上述配置，再关闭 Worker 域名上原有的 Cloudflare Access 保护；如果自定义域名还有 Zero Trust Access Application 保护，也需要移除对应保护。否则访问者仍会先遇到 Cloudflare 的登录页。

通过 HTTPS 打开 Worker 地址或绑定的自定义域名，即可看到用户名/密码登录页。配置不完整时服务拒绝访问，不会开放邮箱。密码模式不支持 HTTP；本地开发不设置 `AUTH_MODE` 时保留原有开发鉴权跳过行为，不要将开发服务暴露到公网。

登录状态有效期 12 小时，使用 Secure / HttpOnly / SameSite=Strict Cookie，不把凭证存入 localStorage。首页的 Sign out 可退出当前浏览器。更改用户名、密码哈希或会话密钥会使所有已有会话失效；忘记密码时重新运行生成脚本并更新 Secret。没有开放注册、邮箱找回密码或多用户管理。

每个来源 IP 15 分钟最多尝试登录 10 次，计数保存在 Durable Objects 中。只存密码哈希，登录请求不记录账号密码。密码模式保护网页、管理 API、AI WebSocket 和 MCP；跨站写请求及 WebSocket 连接会被拒绝。外部 MCP 客户端不接受网站发件 API Key；需要现有 Access 集成的外部 MCP 使用场景可继续选择 Access 模式。

## 2. 为每个网站创建独立发件 Key

先在后台创建需要使用的邮箱，例如 `contact@example.com`。Mailjet 模式还必须完成该地址/域名验证。

```bash
npm run auth:api-key -- contact@example.com
```

脚本生成含有随机 Key 和允许发件地址的 JSON。将 JSON 保存到 Worker Secret `SEND_API_KEYS`：

```bash
npx wrangler secret put SEND_API_KEYS
```

多个网站配置示例（将示例 Key 换成脚本生成的随机值）：

```json
[
  {"name":"website-a","key":"REPLACE_WITH_RANDOM_KEY_A_AT_LEAST_32_CHARACTERS","from":["contact@site-a.com"]},
  {"name":"website-b","key":"REPLACE_WITH_RANDOM_KEY_B_AT_LEAST_32_CHARACTERS","from":["support@site-b.com","noreply@site-b.com"]}
]
```

添加网站时保留已有条目；删除一个条目或更换它的 Key 即可撤销旧 Key。最多 50 把 Key，每把 Key 可配置最多 100 个精确发件地址，不支持通配符。未配置或格式错误时接口关闭。

每个网站只保存属于它的 Key。密钥只能放在网站服务端环境变量中，不能放进浏览器 JavaScript、公开仓库或页面。发件 Key 无法登录后台、读取邮件、管理邮箱或调用 AI/MCP。

## 3. 网站调用统一接口

`POST https://mail.example.com/api/v1/send`

```bash
curl https://mail.example.com/api/v1/send \
  -H "Authorization: Bearer $INBOX_SEND_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "contact@example.com",
    "to": "recipient@example.net",
    "subject": "网站通知",
    "html": "<p>你的操作已完成。</p>",
    "text": "你的操作已完成。"
  }'
```

网站服务端 JavaScript 示例：

```js
const response = await fetch(`${process.env.INBOX_URL}/api/v1/send`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.INBOX_SEND_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    from: "contact@example.com",
    to: "recipient@example.net",
    subject: "网站通知",
    text: "你的操作已完成。",
  }),
});
const result = await response.json();
if (!response.ok) throw new Error(result.error || "发送失败");
// result: { id: "邮箱内部邮件 ID", status: "sent" }
```

必填：`from`、`to`、`subject`，以及 `html` / `text` 至少一个非空正文。`from` 也可为 `{ "email": "contact@example.com", "name": "网站名称" }`；`to`、`cc`、`bcc` 支持单个地址或地址数组。可选 `in_reply_to`、`references` 和 `attachments`：

```json
{"content":"BASE64_CONTENT","filename":"receipt.pdf","type":"application/pdf","disposition":"attachment"}
```

内嵌附件使用 `disposition: "inline"` 和 `contentId`，正文使用 `cid:...` 引用。JSON 请求体最多 20 MiB，还要遵守发件服务自己的附件大小限制。

| HTTP 状态 | 含义 |
| --- | --- |
| 202 | 发件服务已接受，邮件已保存至对应邮箱 Sent；不保证最终投递到收件箱 |
| 400 | 邮件参数或 JSON 错误 |
| 401 | 缺少或错误的 Bearer Key |
| 403 | Key 无权使用该发件地址，或从浏览器携带 Origin 调用 |
| 404 | 发件邮箱尚未创建 |
| 413 | 请求体过大 |
| 429 | API Key 或邮箱达到限流阈值 |
| 502 | 发件服务拒绝或无法确认发送结果 |
| 503 | 发件 API 配置缺失或错误 |

每把 Key 每分钟最多 60 次请求；同时沿用项目现有邮箱发件限制（每小时 20 封、每天 100 封）和供应商额度。这些默认限制适合低频通知，不适合批量营销或高流量验证码服务。请求无自动重试，也没有幂等键支持：超时、502 或发送后保存失败时，先检查供应商记录和 Sent，避免重复发送。接口只供服务端调用，不开放浏览器跨域调用。

## 4. 切换服务或保留 Access

网站始终调用同一个接口，切换发件服务无需修改网站代码：

- Mailjet：`EMAIL_PROVIDER=mailjet`，配置两项 Mailjet Secrets；不需要 `send_email` 绑定。
- Cloudflare：`EMAIL_PROVIDER=cloudflare`，开通发件服务并恢复 `EMAIL` 绑定后重新部署。

需要恢复原有 Access 登录时，设置 `AUTH_MODE=access`（或删除该设置），配置 `POLICY_AUD` / `TEAM_DOMAIN`，并在域名上启用 Access。网站接口仍单独验证 Bearer Key，但如果 Cloudflare 边缘 Access 保护整个域名，还需在 Access 中为 `/api/v1/send` 配置明确的 Bypass 路径策略，或通过网站服务端另外提供 Access Service Token；后者也不能替代发件 Key。个人模式无需这些 Access 配置。

`DOMAINS` 是邮箱域名列表，Worker 自定义域名是管理后台和 API 的访问地址，两者可以不同。无需修改已有邮箱数据或迁移数据库。
