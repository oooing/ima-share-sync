import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
let provider, nativeCall;
export function invalidateLiveIdentity(){
 provider=undefined;nativeCall=undefined;
 const outfile=path.join(root,'.web','live-desktop-provider.cjs');
 delete require.cache[outfile];
}
export async function liveIdentity(){
 if(provider)return provider;
 const outfile=path.join(root,'.web','live-desktop-provider.cjs');
 await build({stdin:{contents:'export {DesktopIdentityProvider} from "./src/desktop-identity-provider";export {runSilentIdentity} from "./src/silent-identity-runner";',resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile});
 const {DesktopIdentityProvider,runSilentIdentity}=require(outfile);
 nativeCall=runSilentIdentity;
 provider=new DesktopIdentityProvider(nativeCall);
 return provider;
}
export async function handleIdentity(req,res){
 res.setHeader('Content-Type','application/json; charset=utf-8');
 if(req.method!=='POST'||req.headers['content-type']!=='application/json'){res.writeHead(405);res.end(JSON.stringify({error:'只支持本机界面的来源查询。'}));return;}
 const origin=req.headers.origin;
 if(origin&&origin!==new URL('http://'+req.headers.host).origin){res.writeHead(403);res.end('{}');return;}
 try{
  let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>500000)throw new Error('查询内容过多。');}
  const {operation,args=[]}=JSON.parse(raw);
  if(!['listKnowledgeBases','listFolders','resolve','matchRecords','nativeIdentity'].includes(operation)||!Array.isArray(args))throw new Error('不支持此操作。');
  if(operation==='nativeIdentity'&&(args.length!==1||!args[0]||typeof args[0]!=='object'||Array.isArray(args[0])))throw new Error('客户端来源请求无效。');
  const desktop=await liveIdentity();const value=operation==='nativeIdentity'?await nativeCall(args[0]):await desktop[operation](...args);
  res.writeHead(200);res.end(JSON.stringify({value}));
 }catch(error){res.writeHead(400);res.end(JSON.stringify({error:error.message||'读取来源失败。',code:error.code}));}
}
