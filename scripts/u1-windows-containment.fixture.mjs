// Benign, fixed local fixture. No network, credentials, files or application code.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const mode=process.argv[2];
// Last-resort orphan ceiling only; a successful containment proof must finish
// in less than30s, so this60s self-expiry cannot satisfy the proof.
setTimeout(()=>process.exit(90),60000);
if(mode==='leaf'){
 process.send?.({schema:'u1-local-leaf-v1',pid:process.pid});
 setInterval(()=>{},1000);
}else if(mode==='overflow-tree'){
 const leaf=spawn(process.execPath,[fileURLToPath(import.meta.url),'leaf'],{shell:false,windowsHide:true,stdio:'ignore',env:{SystemRoot:'C:\\Windows'}});
 leaf.once('error',()=>process.exit(2));
 leaf.once('spawn',()=>process.send({schema:'u1-local-descendant-v1',pid:leaf.pid},err=>{
  if(err)process.exit(3);
  const chunk=Buffer.alloc(1024*1024,120);
  let count=0;
  const emit=()=>{while(count<33){count++;if(!process.stdout.write(chunk)){process.stdout.once('drain',emit);return;}}};
  emit();setInterval(()=>{},1000);
 }));
}else process.exit(4);
