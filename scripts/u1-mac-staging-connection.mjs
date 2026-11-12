// Narrow read-only connection diagnostic. Not a campaign launcher or approval.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, X509Certificate} from 'node:crypto';
import {spawn} from 'node:child_process';

export const CONNECTION_LIMITS = Object.freeze({processMs:15000, exitMs:3000, outputBytes:32*1024*1024});
export const CONNECTION_SQL = `BEGIN READ ONLY;
SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s';
SELECT CASE WHEN current_database()='postgres'
 AND current_setting('transaction_read_only')='on'
 AND (SELECT system_identifier::text FROM pg_control_system())='7623125441096521075'
 AND (SELECT count(*) FROM public.deployment_environment_identity
 WHERE environment='staging' AND project_ref='tkbdyzxwwbhkpztgjjxh'
 AND identity_nonce='f9bc0aed-b6c4-410f-ba2a-572522d03869'::uuid)=1
 THEN 'u1-staging-identity-verified' ELSE 'u1-staging-identity-mismatch' END;
ROLLBACK;`;
const check=(value,message)=>{if(!value)throw new Error(message);};
const keys=(value,names)=>check(value&&Object.keys(value).sort().join(',')===[...names].sort().join(','),'Unexpected connection inputs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

// Accept plain text from a separately reviewed local document extraction only.
// No guessed password variants, credential discovery, or diagnostic echo.
export function parseDbpw(text){
 check(typeof text==='string'&&Buffer.byteLength(text)<=1024*1024&&!text.startsWith('{\\rtf'),'Plain bounded credential text required');
 const lines=text.split(/\r?\n/).filter(line=>/^\s*DBPWSTAGING\b/i.test(line));
 check(lines.length===1,'Exactly one DBPWSTAGING field required');
 const match=/^\s*DBPWSTAGING\s*[:=\-]\s*(\S(?:.*\S)?)\s*$/i.exec(lines[0]);
 check(match&&!/[\x00-\x1f\x7f]/.test(match[1]),'Invalid DBPWSTAGING field');
 return match[1];
}

function pinned(file,expected,maxBytes){
 check(typeof file==='string'&&path.isAbsolute(file)&&fs.realpathSync(file)===file,'Canonical tool path required');
 const stat=fs.lstatSync(file);
 check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=maxBytes,'Bounded regular tool required');
 check(typeof expected==='string'&&/^[a-f0-9]{64}$/.test(expected),'Pinned tool hash required');
 const bytes=fs.readFileSync(file);check(hash(bytes)===expected,'Pinned tool bytes changed');return bytes;
}

export function inspectConnectionInputs(options){
 keys(options,['executable','sha256','sslRootCert','certSha256']);
 check(process.platform==='darwin','Darwin diagnostic only');
 check(path.basename(options.executable)==='psql','Native psql required');
 const executable=pinned(options.executable,options.sha256,64*1024*1024);
 check(['cffaedfe','feedfacf','cefaedfe','feedface','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(executable.subarray(0,4).toString('hex')),'Native Mach-O executable required');
 fs.accessSync(options.executable,fs.constants.X_OK);
 const cert=pinned(options.sslRootCert,options.certSha256,1024*1024);
 try{const parsed=new X509Certificate(cert);check(parsed.ca&&Date.parse(parsed.validFrom)<=Date.now()&&Date.parse(parsed.validTo)>Date.now(),'Current CA certificate required');}catch{throw new Error('Current CA certificate required');}
 return Object.freeze({schema:'u1-mac-connection-inputs-v1',platform:'darwin',executableSha256:options.sha256,certificateSha256:options.certSha256,sqlSha256:hash(CONNECTION_SQL)});
}

export async function run(options){
 keys(options,['executable','sha256','sslRootCert','certSha256','password']);
 check(typeof options.password==='string'&&options.password.length>0&&!/[\x00\r\n]/.test(options.password),'Explicit password required');
 const {password,...inputs}=options;
 const identity=inspectConnectionInputs(inputs);
 return new Promise(resolve=>{
  const started=performance.now();let child,closed=false,done=false,failure=null,observedBytes=0,output='',deadline,exitTimer,killInvoked=false;
  const finish=()=>{
   if(done)return;done=true;clearTimeout(deadline);clearTimeout(exitTimer);
   child?.stdout?.destroy();child?.stderr?.destroy();child?.stdin?.destroy();child?.unref();
   resolve(Object.freeze({...identity,status:!failure&&closed?'verified':'inconclusive',failure,
    exitObserved:closed,killInvoked,manualCleanupRequired:Boolean(child&&!closed),observedBytes,elapsedMs:performance.now()-started}));
  };
  const fail=reason=>{
   if(done)return;failure??=reason;
   if(!child||closed)return finish();
   if(killInvoked)return;
   killInvoked=true;try{child.kill('SIGKILL');}catch{/* Fail closed; never include raw OS diagnostics. */}
   exitTimer=setTimeout(finish,CONNECTION_LIMITS.exitMs);
  };
  try{
   child=spawn(options.executable,['-X','-q','-A','-t','-w','-v','ON_ERROR_STOP=1'],{
    shell:false,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LC_ALL:'C',
     PGHOST:'db.tkbdyzxwwbhkpztgjjxh.supabase.co',PGPORT:'5432',PGDATABASE:'postgres',PGUSER:'postgres',
     PGPASSWORD:password,PGSSLMODE:'verify-full',PGSSLROOTCERT:options.sslRootCert,PGCONNECT_TIMEOUT:'10',
     PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000'}});
  }catch{return fail('spawn-failed');}
  deadline=setTimeout(()=>fail('deadline-exceeded'),CONNECTION_LIMITS.processMs);
  const consume=(bytes,stdout)=>{
   if(done)return;observedBytes+=Buffer.byteLength(bytes);
   if(observedBytes>CONNECTION_LIMITS.outputBytes)return fail('output-limit');
   if(stdout&&!failure)output+=bytes.toString('utf8');
  };
  child.stdout.on('data',bytes=>consume(bytes,true));child.stderr.on('data',bytes=>consume(bytes,false));
  for(const stream of [child.stdout,child.stderr,child.stdin])stream.on('error',()=>fail('stream-failed'));
  child.once('error',()=>fail('spawn-failed'));
  child.once('close',code=>{
   closed=true;if(done)return;
   if(code!==0)failure??='connection-failed';
   if(performance.now()-started>=CONNECTION_LIMITS.processMs)failure??='deadline-exceeded';
   if(output.trim()!=='u1-staging-identity-verified')failure??='identity-unverified';
   finish();
  });
  child.stdin.end(CONNECTION_SQL);
 });
}
