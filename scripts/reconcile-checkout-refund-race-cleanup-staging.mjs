const args = process.argv.slice(2);
if (args.length > 1 || args.some((argument) => argument !== "--void")) {
  throw new Error("Disposition cleanup postflight accepts only refund or exact --void mode.");
}
process.env.E2E_CLEANUP_RACE_KIND = args[0] === "--void" ? "void" : "refund";
process.env.E2E_CHECKOUT_REFUND_RACE_DISPOSITION = process.env.E2E_CLEANUP_RACE_KIND;
await import("./reconcile-checkout-replacement-race-cleanup-staging.mjs");
