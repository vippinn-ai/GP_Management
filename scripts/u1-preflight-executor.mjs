import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildCombinedPreflight,decodePreflightCapture} from './u1-preflight-collector.mjs';
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const sha=b=>createHash('sha256').update(b).digest('hex');
const PINS={'u1-preflight-collector.mjs':'b702ae10c07298c60a18cafd41e108c441e11bfcb307101341f0b4cd942981df','u1-package-builder.mjs':'27aafc3d94b32b1b1def2ddb6b9060778c31e8dda372570f0f74dc6e89aaf42f'};
const DEADLINE=15000,MAX_BYTES=32*1024*1024,TEARDOWN=2000;
function checkedFile(file,hash){
 check(typeof file==='string'&&path.isAbsolute(file)&&fs.realpathSync(file)===path.resolve(file),'Canonical file required');
 check(/^[a-f0-9]{64}$/.test(hash??'')&&sha(fs.readFileSync(file))===hash,'Pinned file bytes changed');return file;
}

// Test seam exercises lifecycle only. Production executePreflight never accepts
// dependencies/clock/limits from its caller and never calls this exported seam.
function observeChild(child,sql,{now,setTimer,clearTimer,terminate,startedAt}){
 return new Promise(resolve=>{
  const start=startedAt??now();let failure=null,done=false,closed=false,bytes=0;const chunks=[];let teardown;
  const finish=()=>{if(done)return;done=true;clearTimer(deadline);if(teardown)clearTimer(teardown);
   resolve({status:failure?'failed':'passed',failure,terminationConfirmed:closed,elapsedMs:now()-start,receivedBytes:bytes,stdout:Buffer.concat(chunks)});};
  const fail=code=>{if(done||failure)return;failure=code;
   if(closed){finish();return;}
   teardown=setTimer(finish,TEARDOWN);
   try{Promise.resolve(terminate(child)).catch(()=>{});}catch{/* bounded teardown still resolves */}
  };
  const deadline=setTimer(()=>fail('deadline-exceeded'),Math.max(0,DEADLINE-(now()-start)));
  child.stdout.on('data',chunk=>{if(done||failure)return;const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=b.length;
   if(bytes>MAX_BYTES){fail('stdout-limit');return;}chunks.push(b);if(now()-start>=DEADLINE)fail('deadline-exceeded');});
  child.stderr.on('data',()=>{/* discard: no raw diagnostic or credentials persisted */});
  child.on('error',()=>fail('child-error'));
  child.on('close',code=>{closed=true;if(!failure&&(now()-start>=DEADLINE||code!==0))failure=code!==0?'child-nonzero':'deadline-exceeded';finish();});
  child.stdin.on('error',()=>fail('stdin-error'));
  if(now()-start>=DEADLINE)fail('deadline-exceeded');
  else try{child.stdin.end(sql);}catch{fail('stdin-error');}
 });
}
export function observeFakeChildForTests(child,sql,dependencies){return observeChild(child,sql,dependencies);}
function terminateOwned(child){
 if(!Number.isSafeInteger(child.pid)||child.pid<=0)return Promise.reject(new Error('No owned PID'));
 if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
 return Promise.resolve();
}

export async function executePreflight(options){
 const allowed=['request','expectedSqlSha256','executable','executableSha256','sslRootCert','sslRootCertSha256','user','password','evidenceDirectory','preparation'];
 check(options&&Object.keys(options).sort().join(',')===allowed.sort().join(','),'Exact executor options required');
 for(const [file,hash] of Object.entries(PINS))check(sha(fs.readFileSync(new URL(file,import.meta.url)))===hash,'Frozen executor dependency drift');
 const generated=buildCombinedPreflight(options.request);
 check(generated.sha256===options.expectedSqlSha256,'Externally approved SQL hash required');
 const executable=checkedFile(options.executable,options.executableSha256);
 check(/^psql(?:\.exe)?$/i.test(path.basename(executable)),'Pinned psql required');
 const certificate=checkedFile(options.sslRootCert,options.sslRootCertSha256);
 check(typeof options.user==='string'&&/^[A-Za-z0-9_]+$/.test(options.user)&&typeof options.password==='string'&&options.password.length>0,'Explicit credentials required');
 const root=path.resolve(import.meta.dirname,'../test-artifacts');const directory=path.resolve(options.evidenceDirectory);
 check(path.isAbsolute(options.evidenceDirectory)&&directory===path.join(root,'u1-preflight',generated.runId)&&fs.realpathSync(directory)===directory&&fs.statSync(directory).isDirectory(),'Existing deterministic canonical private directory required');
 const prep=options.preparation;
 const prepKeys=['runId','applicationCommit','harnessCommit','baseURL','actors','stationIds'];
 check(prep&&Object.keys(prep).filter(k=>k!=='maxAgeMs').sort().join(',')===prepKeys.sort().join(',')&&(!Object.hasOwn(prep,'maxAgeMs')||(Number.isSafeInteger(prep.maxAgeMs)&&prep.maxAgeMs>0&&prep.maxAgeMs<=900000)),'Exact preparation fields required');
 check(prep&&prep.runId===generated.runId&&prep.applicationCommit===generated.applicationCommit&&prep.harnessCommit===generated.harnessCommit&&
  ['A','B'].every(s=>prep.actors?.[s]?.id===generated.request.actorIds[s])&&JSON.stringify(prep.stationIds)===JSON.stringify(generated.request.stationIds),'Preparation identity mismatch');
 check(prep.baseURL==='https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev'&&Object.keys(prep.actors).sort().join(',')==='A,B'&&['A','B'].every(s=>Object.keys(prep.actors[s]).sort().join(',')==='active,id,organization,role'&&prep.actors[s].active===true&&prep.actors[s].organization==='org-primary'&&['admin','manager','receptionist'].includes(prep.actors[s].role)),'Invalid staging preparation actor fields');
 // Directory ACL privacy is a caller prerequisite, NOT established by mode bits.
 // Exclusive attempt file prevents reuse even if spawn fails.
 for(const name of ['attempt.json','preflight.json','draft.json','result.json'])check(!fs.existsSync(path.join(directory,name)),'Reserved evidence file already exists');
 const write=(name,value)=>fs.writeFileSync(path.join(directory,name),typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
 write('attempt.json',{runId:generated.runId,attempt:1,retry:0,sqlSha256:generated.sha256,sourcePins:PINS,executableSha256:options.executableSha256,certificateSha256:options.sslRootCertSha256,startedAt:new Date().toISOString()});
 let observed;
 const processStarted=performance.now();
 try{
  const child=spawn(executable,['-X','-q','-A','-t','-w','-v','ON_ERROR_STOP=1'],{
   windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],
   env:{SystemRoot:process.env.SystemRoot??'C:\\Windows',PGHOST:'db.tkbdyzxwwbhkpztgjjxh.supabase.co',PGPORT:'5432',PGDATABASE:'postgres',PGUSER:options.user,PGPASSWORD:options.password,PGSSLMODE:'verify-full',PGSSLROOTCERT:certificate,PGCONNECT_TIMEOUT:'10'}
  });
  observed=await observeChild(child,generated.sql,{now:()=>performance.now(),setTimer:setTimeout,clearTimer:clearTimeout,terminate:terminateOwned,startedAt:processStarted});
 }catch{observed={status:'failed',failure:'spawn-failed',terminationConfirmed:false,elapsedMs:performance.now()-processStarted,receivedBytes:0,stdout:Buffer.alloc(0)};}
 const result={runId:generated.runId,status:observed.status,failure:observed.failure,terminationConfirmed:observed.terminationConfirmed,elapsedMs:observed.elapsedMs,receivedBytes:observed.receivedBytes,retainedPrefixBytes:observed.stdout.length,retainedPrefixSha256:sha(observed.stdout),sqlSha256:generated.sha256};
 result.attemptSha256=sha(fs.readFileSync(path.join(directory,'attempt.json')));
 try{checkedFile(executable,options.executableSha256);checkedFile(certificate,options.sslRootCertSha256);}catch{result.status='failed';result.failure='dependency-drift';}
 if(result.status==='passed'){
  try{
   const text=new TextDecoder('utf-8',{fatal:true}).decode(observed.stdout);const candidate=JSON.parse(text);
   check(candidate&&typeof candidate==='object'&&!Array.isArray(candidate),'Plain capture required');
   const file=path.join(directory,'preflight.json');write('preflight.json',observed.stdout);
   result.preflightSha256=sha(observed.stdout);
   const decoded=decodePreflightCapture(observed.stdout,{generated,expectedSqlSha256:options.expectedSqlSha256,elapsedMs:observed.elapsedMs,preparation:{...prep,now:Date.now(),preflightFile:fs.realpathSync(file),preflightSha256:sha(observed.stdout)}});
   write('draft.json',decoded.draft);result.draftSha256=sha(fs.readFileSync(path.join(directory,'draft.json')));result.status='captured-not-admitted';
  }catch{result.status='failed';result.failure='capture-validation-failed';}
 }
 write('result.json',result);return result;
}
