import type { BackendFeatureFlags } from "./featureFlags";
import { appStateRemoteDataGateway } from "./appStateGateway";
import { loadNormalizedAppDataOverlay } from "./normalizedReads";
import { invokeOperationalMutationRpc } from "./rpcClient";
import type { RemoteDataGateway } from "./types";

const NOT_IMPLEMENTED_MESSAGE =
  "Normalized RPC or realtime gateway is not implemented yet. Disable RPC/realtime backend feature flags until those adapters are available.";

function unsupportedGatewayCall(): never {
  throw new Error(NOT_IMPLEMENTED_MESSAGE);
}

export function createNormalizedRemoteDataGateway(_flags: BackendFeatureFlags): RemoteDataGateway {
  const gateway: RemoteDataGateway = {
    async loadAppDataSnapshot() {
      const snapshot = await appStateRemoteDataGateway.loadAppDataSnapshot();
      const overlay = await loadNormalizedAppDataOverlay({
        normalizedConfigReads: _flags.normalizedConfigReads,
        normalizedCatalogReads: _flags.normalizedCatalogReads,
        normalizedComboReads: _flags.normalizedComboReads
      });
      return {
        ...snapshot,
        appData: {
          ...snapshot.appData,
          ...overlay.appData
        }
      };
    },
    saveAppData(appData, activeUserId, expectedVersion, telemetryOptions) {
      if (_flags.rpcFinancialWrites) {
        return Promise.reject(new Error(NOT_IMPLEMENTED_MESSAGE));
      }
      return appStateRemoteDataGateway.saveAppData(appData, activeUserId, expectedVersion, telemetryOptions);
    },
    subscribeToAppData(onChange) {
      if (_flags.normalizedRealtime) {
        return unsupportedGatewayCall();
      }
      return appStateRemoteDataGateway.subscribeToAppData(onChange);
    }
  };
  if (_flags.rpcOperationalWrites) {
    gateway.commitOperationalMutation = (mutation) => invokeOperationalMutationRpc(mutation);
  }
  return gateway;
}
