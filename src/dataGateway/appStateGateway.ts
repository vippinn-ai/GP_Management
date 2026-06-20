import { loadRemoteAppDataSnapshot, saveRemoteAppData, subscribeToRemoteAppData } from "../backend";
import type { RemoteDataGateway } from "./types";

export const appStateRemoteDataGateway: RemoteDataGateway = {
  loadAppDataSnapshot: loadRemoteAppDataSnapshot,
  saveAppData: saveRemoteAppData,
  subscribeToAppData: subscribeToRemoteAppData
};
