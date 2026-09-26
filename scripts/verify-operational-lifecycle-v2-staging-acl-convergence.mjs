import { verifyAclPostflight } from "./lifecycle-acl-convergence.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const match = arg.match(/^--(manifest|evidence|phase)=(.+)$/);
  if (!match) throw new Error(`Unknown argument: ${arg}`);
  return [match[1], match[2]];
}));
if (Object.keys(args).length !== 3 || process.argv.length !== 5) throw new Error("Require exactly --manifest, --evidence and --phase=after|before.");
console.log(JSON.stringify(verifyAclPostflight({ root: process.cwd(), manifestPath: args.manifest, evidencePath: args.evidence, phase: args.phase }), null, 2));
