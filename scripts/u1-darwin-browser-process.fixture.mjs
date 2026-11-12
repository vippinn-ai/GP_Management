// Local containment fixture only. Never navigates to a network URL.
import {chromium} from 'playwright';
const mode=process.argv[2];
if(!['normal','failure','output','hold'].includes(mode))throw new Error('Unknown local fixture');
const browser=await chromium.connect(process.env.U1_DARWIN_BROWSER_WS_ENDPOINT);
const context=await browser.newContext();const page=await context.newPage();
await page.setContent('<title>Local containment</title><p>offline</p>');
if(await page.title()!=='Local containment')throw new Error('Local browser failed');
if(mode==='normal'){await context.close();await browser.close();}
else if(mode==='failure')process.exit(2);
else if(mode==='output'){const b=Buffer.alloc(1024*1024);for(let i=0;i<18;i++){process.stdout.write(b);process.stderr.write(b);}setInterval(()=>{},1000);}
else setInterval(()=>{},1000);
