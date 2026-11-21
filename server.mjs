import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiHandler } from "./src/api.mjs";
import { createDatabasePool } from "./src/db/pool.mjs";

const ROOT=path.dirname(fileURLToPath(import.meta.url)),PORT=Number(process.env.PORT||4173),HOST=process.env.HOST||"127.0.0.1";
const MIME={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml"};
const pool=process.env.DATABASE_URL?createDatabasePool(process.env.DATABASE_URL):null;
const handleApi=createApiHandler({pool});
const server=http.createServer(async(req,res)=>{
  if(await handleApi(req,res))return;
  const url=new URL(req.url||"/","http://localhost");
  if(req.method!=="GET"&&req.method!=="HEAD"){res.writeHead(405,{"content-type":"text/plain; charset=utf-8",allow:"GET, HEAD"});res.end("Method not allowed");return}
  if(url.pathname==="/api/health"){res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});res.end(JSON.stringify({status:"ok",mode:"simulation",service:"cloudexify-dashboard",api:pool?"configured":"not_configured"}));return}
  let requested;try{requested=url.pathname==="/"?"/index.html":decodeURIComponent(url.pathname)}catch{res.writeHead(400);res.end("Bad request");return}
  const filePath=path.resolve(ROOT,"."+requested);if(filePath!==ROOT&&!filePath.startsWith(ROOT+path.sep)){res.writeHead(403);res.end("Forbidden");return}
  try{const body=await readFile(filePath);res.writeHead(200,{"content-type":MIME[path.extname(filePath)]||"application/octet-stream","x-content-type-options":"nosniff"});res.end(req.method==="HEAD"?undefined:body)}catch{res.writeHead(404,{"content-type":"text/plain; charset=utf-8"});res.end("Not found")}
});
server.listen(PORT,HOST,()=>console.log("Cloudexify dashboard/control plane listening on http://"+HOST+":"+PORT));
server.on("close",()=>{if(pool)pool.end().catch(()=>{})});
