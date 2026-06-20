import type { BackendFeatureFlags } from "./featureFlags";
import type { RemoteDataGateway } from "./types";

const NOT_IMPLEMENTED_MESSAGE =
  "Normalized data gateway is not implemented yet. Disable normalized/RPC backend feature flags until Phase 3 adapters are available.";

function unsupportedGatewayCall(): never {
  throw new Error(NOT_IMPLEMENTED_MESSAGE);
}

export function createNormalizedRemoteDataGateway(_flags: BackendFeatureFlags): RemoteDataGateway {
  return {
    loadAppDataSnapshot: () => Promise.reject(new Error(NOT_IMPLEMENTED_MESSAGE)),
    saveAppData: () => Promise.reject(new Error(NOT_IMPLEMENTED_MESSAGE)),
    subscribeToAppData: unsupportedGatewayCall
  };
}
