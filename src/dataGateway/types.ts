import type { RemoteAppDataSnapshot, SaveRemoteTelemetryOptions } from "../backend";
import type { AppData } from "../types";

export interface RemoteDataGateway {
  loadAppDataSnapshot(): Promise<RemoteAppDataSnapshot>;
  saveAppData(
    appData: AppData,
    activeUserId: string,
    expectedVersion: number,
    telemetryOptions?: SaveRemoteTelemetryOptions
  ): Promise<number>;
  subscribeToAppData(onChange: (snapshot: RemoteAppDataSnapshot) => void): () => void;
}
