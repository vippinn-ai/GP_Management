import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const argument=(name)=>{
  const marker=`--${name}=`;
  const value=process.argv.slice(2).find((entry)=>entry.startsWith(marker))?.slice(marker.length);
  if(!value) throw new Error(`Missing ${marker}<value>.`);
  return value;
};
const port=Number(argument("port"));
const token=argument("token");
const outputPath=path.resolve(process.cwd(),argument("output"));
if(!Number.isInteger(port)||port<1024||port>65535) throw new Error("Use a non-privileged local port.");
if(!/^[a-z0-9-]{20,}$/i.test(token)) throw new Error("Use a high-entropy local capture token.");
if(fs.existsSync(outputPath)) throw new Error("Evidence output already exists.");
fs.mkdirSync(path.dirname(outputPath),{recursive:true});

const server=http.createServer((request,response)=>{
  if(request.method!=="POST"||request.url!==`/${token}`){ response.writeHead(404).end(); return; }
  const chunks=[]; let size=0;
  request.on("data",(chunk)=>{
    size+=chunk.length;
    if(size>2_000_000){ request.destroy(new Error("Evidence payload exceeds 2 MB.")); return; }
    chunks.push(chunk);
  });
  request.on("end",()=>{
    const bytes=Buffer.concat(chunks);
    JSON.parse(bytes.toString("utf8"));
    fs.writeFileSync(outputPath,bytes,{flag:"wx"});
    const result={path:outputPath,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
    response.writeHead(201,{"content-type":"application/json"}).end(JSON.stringify(result));
    server.close(()=>process.stdout.write(`${JSON.stringify(result)}\n`));
  });
});
server.listen(port,"127.0.0.1",()=>process.stdout.write(`${JSON.stringify({listening:true,port})}\n`));
