export type QaNormalizedReadFailureTarget = "bill-history" | "reports" | "customers" | "inventory";

export const QA_NORMALIZED_READ_FAILURE_HOST =
  "gp-management-staging-failclosed-qa.breakperfectgaminglounge.workers.dev";
export const QA_NORMALIZED_READ_FAILURE_QUERY_PARAM = "qaNormalizedReadFailure";

const QA_NORMALIZED_READ_FAILURE_DELAY_MS = 350;
const QA_NORMALIZED_READ_EXPECTED_BUILD_ID = "release-a-failclosed-qa-v1";
const QA_NORMALIZED_READ_BUILD_ID = import.meta.env.VITE_QA_FAIL_CLOSED_BUILD_ID;
const QA_NORMALIZED_READ_BUILD_ARTIFACT_MARKER = `qa-failclosed-build-id=${QA_NORMALIZED_READ_BUILD_ID}`;
const QA_NORMALIZED_READ_EXPECTED_BUILD_CONTRACT =
  "qa=true|bootstrap=true|customer=true|bills=true|reports=true|analytics=true|inventory=true|v2=false";
const QA_NORMALIZED_READ_BUILD_CONTRACT = [
  `qa=${import.meta.env.VITE_QA_NORMALIZED_READ_FAILURES}`,
  `bootstrap=${import.meta.env.VITE_BACKEND_NORMALIZED_BOOTSTRAP}`,
  `customer=${import.meta.env.VITE_BACKEND_NORMALIZED_CUSTOMER_SEARCH_READS}`,
  `bills=${import.meta.env.VITE_BACKEND_NORMALIZED_BILL_HISTORY_READS}`,
  `reports=${import.meta.env.VITE_BACKEND_NORMALIZED_REPORT_READS}`,
  `analytics=${import.meta.env.VITE_BACKEND_ANALYTICS_SUMMARY_READS}`,
  `inventory=${import.meta.env.VITE_BACKEND_INVENTORY_REPORT_READS}`,
  `v2=${import.meta.env.VITE_BACKEND_FINANCIAL_RPC_V2}`
].join("|");
const QA_NORMALIZED_READ_FAILURE_TARGETS = new Set<QaNormalizedReadFailureTarget>([
  "bill-history",
  "reports",
  "customers",
  "inventory"
]);

interface QaNormalizedReadFailureContext {
  enabled: boolean;
  hostname: string;
  search: string;
  delayMs?: number;
}

function getBrowserContext(): QaNormalizedReadFailureContext {
  return {
    enabled:
      QA_NORMALIZED_READ_BUILD_CONTRACT === QA_NORMALIZED_READ_EXPECTED_BUILD_CONTRACT &&
      QA_NORMALIZED_READ_BUILD_ID === QA_NORMALIZED_READ_EXPECTED_BUILD_ID,
    hostname: typeof window === "undefined" ? "" : window.location.hostname,
    search: typeof window === "undefined" ? "" : window.location.search
  };
}

export function resolveQaNormalizedReadFailureTarget(
  context: QaNormalizedReadFailureContext
): QaNormalizedReadFailureTarget | undefined {
  if (!context.enabled || context.hostname !== QA_NORMALIZED_READ_FAILURE_HOST) {
    return undefined;
  }

  const requestedTarget = new URLSearchParams(context.search).get(QA_NORMALIZED_READ_FAILURE_QUERY_PARAM);
  return requestedTarget && QA_NORMALIZED_READ_FAILURE_TARGETS.has(requestedTarget as QaNormalizedReadFailureTarget)
    ? requestedTarget as QaNormalizedReadFailureTarget
    : undefined;
}

export function runQaControlledNormalizedRead<T>(
  target: QaNormalizedReadFailureTarget,
  read: () => Promise<T>,
  context: QaNormalizedReadFailureContext = getBrowserContext()
): Promise<T> {
  if (resolveQaNormalizedReadFailureTarget(context) !== target) {
    return read();
  }

  return new Promise<T>((_resolve, reject) => {
    globalThis.setTimeout(() => {
      reject(
        new Error(
          `Controlled QA failure: normalized ${target} read is unavailable. (${QA_NORMALIZED_READ_BUILD_ARTIFACT_MARKER})`
        )
      );
    }, context.delayMs ?? QA_NORMALIZED_READ_FAILURE_DELAY_MS);
  });
}
