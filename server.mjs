import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const MIME = {".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml"};
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/api/health") {
    res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
    res.end(JSON.stringify({status:"ok",mode:"simulation",service:"cloudexify-dashboard"}));
    return;
  }
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.resolve(ROOT, "." + requested);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403,{"content-type":"text/plain; charset=utf-8"});res.end("Forbidden");return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200,{"content-type":MIME[path.extname(filePath)] || "application/octet-stream","x-content-type-options":"nosniff"});
    res.end(body);
  } catch {
    res.writeHead(404,{"content-type":"text/plain; charset=utf-8"});res.end("Not found");
  }
});
server.listen(PORT,HOST,()=>console.log(`Cloudexify dashboard (simulation) listening on http://${HOST}:${PORT}`));
