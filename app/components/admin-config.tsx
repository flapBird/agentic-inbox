import { Button } from "@cloudflare/kumo";
import { useEffect, useState } from 'react';
type Key = {id:string;name:string;from:string[]};
export function AdminConfig({ mailboxId }: { mailboxId?: string }) {
 const [keys,setKeys]=useState<{id:string;name:string;from:string[]}[]>([]);
 const [name,setName]=useState(''); const [secret,setSecret]=useState('');
 const [message,setMessage]=useState(''); const [busy,setBusy]=useState(false); const [ready,setReady]=useState(false);
 async function request<T = unknown>(path:string,method='GET',body?:unknown): Promise<T>{const r=await fetch('/api/v1/admin/'+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok){const data=await r.json().catch(()=>({})) as {error?:string};throw new Error(data.error||'操作失败');}return (r.status===204?null:await r.json()) as T;}
 useEffect(()=>{setReady(false);setSecret('');request<Key[]>('keys').then(k=>{setKeys(k);setReady(true);}).catch(e=>setMessage(e.message));},[mailboxId]);
 async function run(action:()=>Promise<void>){setBusy(true);setMessage('');try{await action();}catch(e){setMessage(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}}
 const input='block w-full rounded border border-kumo-line bg-kumo-base p-2 my-2';
 return <section className="rounded-lg border border-kumo-line p-5 space-y-4">
 <h2 className="font-semibold">发件 API Key</h2>
 <p role="status">{message}</p>
 <fieldset disabled={busy||!ready} className="space-y-3 disabled:opacity-60">
 {mailboxId && <><p className="text-sm">页面创建的 Key 只显示一次，服务端仅保存哈希。已有 Worker Secret Key 继续有效，需在原 Secret 中撤销。</p>
 <label>服务名称<input className={input} value={name} onChange={e=>setName(e.target.value)}/></label>
 <p>发件邮箱：{mailboxId}</p>
 <Button variant="primary" loading={busy} disabled={!name.trim() || !ready} type="button" onClick={()=>run(async()=>{setSecret('');const r=await request<{key:string}>('keys','POST',{name,from:[mailboxId]});setSecret(r.key);setKeys(await request<Key[]>('keys'));})}>创建 API Key</Button>
 {secret&&<div><p>请立即复制并保存在接入服务的后端环境变量中：</p><textarea aria-label="新 API Key" readOnly className={input} value={secret}/><Button variant="secondary" type="button" onClick={()=>setSecret('')}>隐藏密钥</Button></div>}
 {keys.filter(k=>k.from.some(address=>address.toLowerCase()===mailboxId?.toLowerCase())).map(k=><div key={k.id} className="border-t border-kumo-line py-2"><strong>{k.name}</strong><p>{k.from.join(', ')}</p><Button variant="destructive" size="sm" type="button" onClick={()=>{if(window.confirm(`撤销 ${k.name} 的 Key？该 Key 授权的所有邮箱都将停止发送。`))void run(async()=>{await request('keys/'+k.id,'DELETE');setKeys(await request<Key[]>('keys'));setMessage('已撤销');});}}>撤销</Button></div>)}
 </>}
 </fieldset></section>;
}
