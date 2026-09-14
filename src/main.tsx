import { defaultRemoteDataGateway } from "./dataGateway";
import "./styles.css";

function markStartupPerformance(name: string) {
  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    performance.mark(name);
  }
}

async function startApp() {
  markStartupPerformance("bp-app-module-requested");
  const appModulePromise = import("./atomicAppMount");
  const bootstrapPreparation = defaultRemoteDataGateway.prepareAuthenticatedBootstrap?.();
  void bootstrapPreparation?.catch(() => undefined);
  const { mountAtomicApp } = await appModulePromise;
  markStartupPerformance("bp-app-module-ready");
  mountAtomicApp();
}

void startApp();
