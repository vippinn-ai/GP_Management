import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = process.cwd();
const lifecyclePath = path.join(root, "supabase", "operational-lifecycle-v2.sql");
const customerTabPath = path.join(root, "supabase", "phase4-customer-tab-rpcs.sql");
const outDir = path.join(root, "test-artifacts", "operational-lifecycle-v2");
const outPath = path.join(outDir, "staging-install.sql");

const lifecycle = fs.readFileSync(lifecyclePath, "utf8").trim();
const customerTabs = fs.readFileSync(customerTabPath, "utf8");
const match = customerTabs.match(
  /create or replace function public\.open_customer_tab\(payload jsonb\)[\s\S]*?\$\$;\s*[\s\S]*?grant execute on function public\.open_customer_tab\(jsonb\) to authenticated;/i
);
if (!match) {
  throw new Error("Unable to extract the reviewed open_customer_tab function and grants.");
}

const install = [
  "-- Generated narrow staging install. Review hash before execution.",
  "begin;",
  lifecycle,
  match[0].trim(),
  `do $$
declare
  function_name text;
  function_body text;
begin
  foreach function_name in array array['hop_session_v2', 'reject_session_v2', 'reject_customer_tab_v2'] loop
    select pg_get_functiondef(p.oid) into function_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = function_name and pg_get_function_identity_arguments(p.oid) = 'payload jsonb';
    if function_body is null then raise exception 'missing installed function %', function_name; end if;
    if function_body ~* '\\mapp_state\\M' or function_body ~* 'patch_app_state' then
      raise exception 'forbidden app_state reference in %', function_name;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.hop_session_v2(jsonb)', 'execute')
    or has_function_privilege('anon', 'public.reject_session_v2(jsonb)', 'execute')
    or has_function_privilege('anon', 'public.reject_customer_tab_v2(jsonb)', 'execute') then
    raise exception 'anonymous lifecycle v2 execution is forbidden';
  end if;
end $$;`,
  "commit;",
  ""
].join("\n\n");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, install, "utf8");
const sha256 = crypto.createHash("sha256").update(install).digest("hex");
process.stdout.write(JSON.stringify({ outPath, bytes: Buffer.byteLength(install), sha256 }, null, 2) + "\n");

