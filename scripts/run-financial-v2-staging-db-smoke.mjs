import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import {
  assertLiveCredentials,
  assertStagingSupabaseEnvironment,
  parseEnvFile,
  STAGING_PROJECT_REF
} from "./playwright-staging-env.mjs";

const root = process.cwd();
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const env = { ...localEnv, ...process.env };

assertStagingSupabaseEnvironment(stagingEnv, true);
assertLiveCredentials(env);

const supabaseUrl = stagingEnv.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = stagingEnv.VITE_SUPABASE_ANON_KEY?.trim();
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("The ignored staging environment must contain the Supabase URL and anon key.");
}
if (new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`) {
  throw new Error("Financial v2 smoke tests are locked to the staging Supabase project.");
}

function client() {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

function operationalCode(error) {
  for (const candidate of [error?.details, error?.message]) {
    if (typeof candidate !== "string") continue;
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed?.code === "string") return parsed.code;
    } catch {
      const match = candidate.match(/\b(?:organization_access_denied|actor_spoof_rejected|invalid_payload)\b/);
      if (match) return match[0];
    }
  }
  return error?.code;
}

function assertRejected(result, expected, label) {
  if (!result.error) throw new Error(`${label} unexpectedly succeeded.`);
  const code = operationalCode(result.error);
  if (expected instanceof RegExp) {
    const text = [code, result.error.code, result.error.message, result.error.details].filter(Boolean).join(" ");
    if (!expected.test(text)) throw new Error(`${label} returned an unexpected rejection.`);
  } else if (code !== expected) {
    throw new Error(`${label} returned ${code ?? "an unclassified rejection"}, expected ${expected}.`);
  }
  return { label, status: "passed", code: code ?? result.error.code ?? "permission_denied" };
}

function rejectionCode(result) {
  return result.error ? operationalCode(result.error) : null;
}

async function signInWithUsername(supabase, username, password) {
  const lookup = await supabase.functions.invoke("resolve-login-email", {
    body: { username: username.trim() }
  });
  if (lookup.error || !lookup.data?.email) throw new Error("Unable to resolve the staging test username.");
  const login = await supabase.auth.signInWithPassword({ email: lookup.data.email, password });
  if (login.error || !login.data.user) throw new Error("Unable to authenticate the staging test account.");
  return login.data.user.id;
}

const evidence = {
  runner: "financial-v2-staging-db-smoke",
  projectRef: STAGING_PROJECT_REF,
  retries: 0,
  productionAllowed: false,
  checks: []
};

const anonymous = client();
const anonymousResult = await anonymous.rpc("commit_checkout_bill_v2", { payload: {} });
evidence.checks.push(assertRejected(anonymousResult, /permission denied|401|42501/i, "anonymous checkout"));

const authenticated = client();
const actorUserId = await signInWithUsername(authenticated, env.E2E_USER_A, env.E2E_PASSWORD_A);
const organization = await authenticated
  .from("organizations")
  .select("id")
  .eq("active", true)
  .order("created_at", { ascending: true })
  .limit(1)
  .maybeSingle();
if (organization.error || !organization.data?.id) throw new Error("Unable to resolve the staging organization.");
const organizationId = organization.data.id;

const wrongOrganizationResult = await authenticated.rpc("commit_checkout_bill_v2", {
  payload: {
    organization_id: "release-b-wrong-organization",
    mutation_id: "release-b-wrong-org",
    mutation_kind: "commitCheckoutBill"
  }
});
evidence.checks.push(assertRejected(wrongOrganizationResult, "organization_access_denied", "wrong organization"));

const actorSpoofResult = await authenticated.rpc("commit_checkout_bill_v2", {
  payload: {
    organization_id: organizationId,
    mutation_id: "release-b-actor-spoof",
    mutation_kind: "commitCheckoutBill",
    user_id: "00000000-0000-0000-0000-000000000000"
  }
});
evidence.checks.push(assertRejected(actorSpoofResult, "actor_spoof_rejected", "client actor spoof"));

const malformedResult = await authenticated.rpc("commit_checkout_bill_v2", {
  payload: {
    organization_id: organizationId,
    mutation_id: "release-b-malformed",
    mutation_kind: "commitCheckoutBill"
  }
});
evidence.checks.push(assertRejected(malformedResult, "invalid_payload", "malformed checkout"));

const statusResult = await authenticated.rpc("get_financial_mutation_result", {
  payload: {
    organization_id: organizationId,
    mutation_id: "release-b-missing-mutation",
    mutation_kind: "commitCheckoutBill"
  }
});
if (statusResult.error || statusResult.data !== null) {
  throw new Error("A missing mutation status lookup must return null without an error.");
}
evidence.checks.push({ label: "missing mutation status", status: "passed", result: "null" });

const restricted = client();
const restrictedUserId = await signInWithUsername(restricted, env.E2E_USER_B, env.E2E_PASSWORD_B);
let restrictedRoleRestored = true;
if (restrictedUserId === actorUserId) {
  evidence.checks.push({
    label: "non-admin financial role boundary",
    status: "not-run",
    reason: "Credential slots A and B resolve to the same admin user; use the transactional SQL authorization proof."
  });
} else {
const restrictedProfile = await authenticated
  .from("profiles")
  .select("name,username,role,active,tab_permissions")
  .eq("id", restrictedUserId)
  .maybeSingle();
if (restrictedProfile.error || !restrictedProfile.data) {
  throw new Error("Unable to verify the second staging test account role.");
}
if (restrictedProfile.data.active !== true) throw new Error("Staging account B must be active.");

async function updateRestrictedRole(role) {
  const update = await authenticated.functions.invoke("admin-update-user", {
    body: {
      id: restrictedUserId,
      name: restrictedProfile.data.name,
      username: restrictedProfile.data.username,
      role,
      tabPermissions: restrictedProfile.data.tab_permissions ?? undefined
    }
  });
  if (update.error) throw new Error(`Unable to set staging account B role to ${role}.`);
  const resolved = await restricted.rpc("current_user_org_role", { target_organization_id: organizationId });
  if (resolved.error || resolved.data !== role) {
    throw new Error(`Staging account B organization role did not become ${role}.`);
  }
}

restrictedRoleRestored = restrictedProfile.data.role !== "admin";
try {
  if (restrictedProfile.data.role === "admin") await updateRestrictedRole("receptionist");

  for (const mutationKind of ["writeOffPendingBills", "voidBill", "refundBill"]) {
    const restrictedResult = await restricted.rpc("commit_financial_adjustment_v2", {
      payload: {
        organization_id: organizationId,
        mutation_id: `release-b-role-${mutationKind}`,
        mutation_kind: mutationKind,
        entity_type: "bill",
        entity_id: "release-b-role-check",
        payload: { bill_updates: [{ id: "release-b-role-check" }] }
      }
    });
    evidence.checks.push(assertRejected(restrictedResult, "role_access_denied", `non-admin ${mutationKind}`));
  }

  const restrictedReplacementResult = await restricted.rpc("commit_checkout_bill_v2", {
    payload: {
      organization_id: organizationId,
      mutation_id: "release-b-role-bill-replacement",
      mutation_kind: "commitCheckoutBill",
      entity_type: "bill",
      entity_id: "release-b-role-check",
      payload: {
        mode: "bill_replacement",
        primary_bill: {
          id: "release-b-role-replacement",
          billNumber: "RELEASE-B-ROLE-REPLACEMENT"
        },
        bill_updates: [{
          id: "release-b-role-replacement",
          billNumber: "RELEASE-B-ROLE-REPLACEMENT"
        }]
      }
    }
  });
  evidence.checks.push(assertRejected(restrictedReplacementResult, "role_access_denied", "non-admin bill replacement"));

  const permittedSettlementResult = await restricted.rpc("commit_financial_adjustment_v2", {
    payload: {
      organization_id: organizationId,
      mutation_id: "release-b-role-settlement",
      mutation_kind: "settlePendingBills",
      entity_type: "bill",
      entity_id: "release-b-role-check",
      payload: {
        bill_updates: [{ id: "release-b-role-check" }],
        bill_expectations: [{
          billId: "release-b-role-check",
          expectedStatus: "pending",
          expectedAmountPaid: 0,
          expectedAmountDue: 1
        }]
      }
    }
  });
  if (!permittedSettlementResult.error || rejectionCode(permittedSettlementResult) === "role_access_denied") {
    throw new Error("A permitted non-admin settlement probe must reach domain validation without succeeding or being role-denied.");
  }
  evidence.checks.push({
    label: "non-admin settlement role compatibility",
    status: "passed",
    domainRejection: rejectionCode(permittedSettlementResult) ?? permittedSettlementResult.error.code
  });
} finally {
  if (restrictedProfile.data.role === "admin") {
    await updateRestrictedRole("admin");
    restrictedRoleRestored = true;
  }
}
}

evidence.actorAuthenticated = Boolean(actorUserId);
evidence.restrictedRoleTested = restrictedUserId === actorUserId ? "transactional-sql-only" : "receptionist";
evidence.restrictedRoleRestored = restrictedRoleRestored;
evidence.organizationResolved = Boolean(organizationId);
evidence.completedAt = new Date().toISOString();
console.log(JSON.stringify(evidence, null, 2));
