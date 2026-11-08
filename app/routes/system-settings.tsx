import { Link } from "react-router";
import { AdminConfig } from "~/components/admin-config";

export function meta() {
 return [{ title: "系统设置 · Agentic Inbox" }];
}

export default function SystemSettingsRoute() {
 return (
  <main className="min-h-screen bg-kumo-recessed text-kumo-default">
   <div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
    <nav aria-label="全局导航" className="flex flex-wrap gap-5 mb-6 text-sm">
     <Link to="/" className="text-kumo-subtle underline">邮箱管理</Link>
     <Link to="/settings" aria-current="page" className="font-semibold">系统设置</Link>
    </nav>
    <h1 className="text-2xl font-bold mb-2">系统设置</h1>
    <p className="text-sm text-kumo-subtle mb-8">管理所有服务的发件 API Key、收件域名及邮箱白名单。新增和查看邮箱请进入邮箱管理。</p>
    <AdminConfig />
   </div>
  </main>
 );
}
