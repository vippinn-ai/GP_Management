// LOCAL PREPARATION ONLY. Incomplete executable draft paths were removed.
import path from 'node:path';
import {U1_IDENTITY,U1_LIMITS,verifyDiscovery} from './u1-playwright-runner.mjs';
import {canonicalHash} from './u1-data-reconciler.mjs';
export const LAUNCH_LIMITS=Object.freeze({discoveryMs:60000,processMs:1200000,killMs:5000,exitMs:3000,outputBytes:32*1024*1024});
export const EXECUTION_BLOCKERS=Object.freeze([
 'Independent reviewer/tester approvals must bind the exact outer admission core, tools, source and package.',
 'A complete reviewed baseline deployment and index/JS/CSS restoration descriptor is missing.',
 'Strict canonical closeout receipt schemas, paths and private-credential retirement evidence are incomplete.',
 'Failed acceptance must distinguish reconciled safety from residue or unverified safety without fabricated success.',
 'Owned-process termination must await both bounded kill outcome and child close; real Windows supervision is unverified.',
 'Exact admission/source revalidation after reconciliation and strict reference schemas remain incomplete.',
 'The complete source approval inventory must include launcher and runtime-provider tests.',
]);
const DISABLED='U1 live launcher admission contract incomplete';
const fixedArgs=Object.freeze(['test','--config=playwright.u1.config.ts','--project=u1-baseline','--workers=1','--retries=0','--repeat-each=1','--max-failures=1','--reporter=json']);
// Descriptive only: no inputs, files, environment, credentials or approvals read.
export function prepareLaunch(){
 return Object.freeze({status:'blocked-not-live-admitted',executionEnabled:false,admissionValidated:false,identity:U1_IDENTITY,limits:U1_LIMITS,processLimits:LAUNCH_LIMITS,discoveryArgs:Object.freeze([...fixedArgs,'--list']),runArgs:fixedArgs,blockers:EXECUTION_BLOCKERS});
}
export async function launchOnce(){throw new Error(DISABLED);}
export function verifyCloseout(){throw new Error(DISABLED);}
// Pure parser only: supplied JSON is not provenance or execution evidence.
export function validateDiscoveryReport(report){
 const specs=[];
 const walk=s=>{for(const spec of s.specs??[])specs.push(spec);for(const child of s.suites??[])walk(child);};
 walk(report);
 if(report.errors?.length||specs.length!==1)throw new Error('Discovery errors or extra tests');
 const spec=specs[0];
 if(spec.tests?.length!==1)throw new Error('Duplicate project/repeat');
 verifyDiscovery([{file:path.basename(spec.file),title:spec.title,project:spec.tests[0].projectName}]);
 return Object.freeze({identity:U1_IDENTITY,tests:1,files:1,reportSha256:canonicalHash(report)});
}
