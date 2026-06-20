import type { RemoteAppDataSnapshot, SaveRemoteTelemetryOptions } from "../backend";
import type { OperationalMutation } from "../operationalSync";
import type { AppData } from "../types";

export interface OperationalRpcCommitResult {
  mutationId: string;
  rpcName: string;
  organizationId: string;
  entityType: OperationalMutation["entityType"];
  entityId: string;
  eventId?: string;
  serverTime?: string;
  changedRows?: Record<string, unknown>;
  raw?: unknown;
}

export interface RemoteDataGateway {
  loadAppDataSnapshot(): Promise<RemoteAppDataSnapshot>;
  saveAppData(
    appData: AppData,
    activeUserId: string,
    expectedVersion: number,
    telemetryOptions?: SaveRemoteTelemetryOptions
  ): Promise<number>;
  commitOperationalMutation?(mutation: OperationalMutation): Promise<OperationalRpcCommitResult>;
  subscribeToAppData(onChange: (snapshot: RemoteAppDataSnapshot) => void): () => void;
}
