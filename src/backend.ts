import {
  createClient,
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
  type RealtimePostgresChangesPayload,
  type RealtimeChannel,
  type SupabaseClient
} from "@supabase/supabase-js";
import type { AppData, Role, User } from "./types";
import { hydrateAppData } from "./storage";
import {
  recordAppStateSaveTelemetry,
  recordRealtimeSnapshotTelemetry,
  type SyncTelemetrySource
} from "./syncTelemetry";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const REMOTE_REQUEST_TIMEOUT_MS = 15_000;

interface LoginEmailResponse {
  email: string;
}

interface AdminUserPayload {
  id?: string;
  name: string;
  username: string;
  role: Role;
  password?: string;
  tabPermissions?: import("./types").TabId[];
}

interface RemoteAppStateRow {
  id: string;
  data: Partial<AppData> | null;
  version?: number | null;
}

interface RemoteAppStateMetadataRow {
  id: string;
  version?: number | null;
  updated_at?: string | null;
}

export interface RemoteProfile {
  id: string;
  name: string;
  username: string;
  role: Role;
  active: boolean;
}

export type RemoteAppDataSnapshotSource = "app_state" | "normalized_bootstrap";

export interface RemoteAppDataSnapshot {
  appData: AppData;
  version: number;
  source: RemoteAppDataSnapshotSource;
  sourceMutationId?: string;
}

export interface RemoteAppStateMetadata {
  version: number;
  updatedAt?: string;
}

export interface SaveRemoteTelemetryOptions {
  actionLabel?: string;
  source?: Exclude<SyncTelemetrySource, "realtime">;
  pendingOperationCount?: number;
}

export type RemoteSessionProfileResult =
  | { status: "no-session" }
  | { status: "active"; profile: RemoteProfile }
  | { status: "inactive-or-missing"; userId: string }
  | { status: "profile-unreachable"; userId: string; error: Error };

let supabaseClient: SupabaseClient | null = null;
let cachedProfiles: RemoteProfile[] = [];

async function withRemoteTimeout<T>(request: PromiseLike<T>, action: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `Unable to reach the remote server while ${action}. Check the Supabase project URL and network connection.`
        )
      );
    }, REMOTE_REQUEST_TIMEOUT_MS);
  });

  try {
    return await Promise.race([Promise.resolve(request), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function getSupabase(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Supabase environment variables are not configured.");
  }
  if (!supabaseClient) {
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true
      }
    });
  }
  return supabaseClient;
}

export function getSupabaseClient(): SupabaseClient {
  return getSupabase();
}

function mapProfileToUser(profile: RemoteProfile): User {
  return {
    id: profile.id,
    name: profile.name,
    username: profile.username,
    role: profile.role,
    active: profile.active
  };
}

function sanitizeAppData(appData: AppData): Partial<AppData> {
  const { users: _users, ...rest } = appData;
  return rest;
}

function snapshotFromAppStateRow(row: RemoteAppStateRow | null): RemoteAppDataSnapshot {
  return {
    appData: hydrateAppData({
      ...(row?.data ?? {}),
      users: cachedProfiles.map(mapProfileToUser)
    }),
    version: row?.version ?? 0,
    source: "app_state"
  };
}

export function isBackendConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

export async function signInWithUsername(username: string, password: string): Promise<RemoteProfile> {
  const supabase = getSupabase();
  const { data: emailLookup, error: emailLookupError } = await withRemoteTimeout(
    supabase.functions.invoke<LoginEmailResponse>(
      "resolve-login-email",
      {
        body: { username: username.trim() }
      }
    ),
    "resolving the login username"
  );
  if (emailLookupError || !emailLookup?.email) {
    throw new Error("Invalid username or password.");
  }
  const { error } = await withRemoteTimeout(
    supabase.auth.signInWithPassword({
      email: emailLookup.email,
      password
    }),
    "signing in"
  );
  if (error) {
    throw new Error("Invalid username or password.");
  }
  const profile = await fetchCurrentProfile();
  if (!profile) {
    throw new Error("Unable to load user profile.");
  }
  if (!profile.active) {
    await supabase.auth.signOut();
    throw new Error("This user account is disabled.");
  }
  return profile;
}

export async function signOutRemote(): Promise<void> {
  await getSupabase().auth.signOut();
}

export async function fetchCurrentProfile(): Promise<RemoteProfile | null> {
  const result = await resolveRemoteSessionProfile();
  return result.status === "active" ? result.profile : null;
}

export async function resolveRemoteSessionProfile(): Promise<RemoteSessionProfileResult> {
  const supabase = getSupabase();
  const {
    data: { session }
  } = await supabase.auth.getSession();
  const authUserId = session?.user?.id;
  if (!authUserId) {
    return { status: "no-session" };
  }
  try {
    const { data, error } = await withRemoteTimeout(
      supabase
        .from("profiles")
        .select("id, name, username, role, active")
        .eq("id", authUserId)
        .maybeSingle(),
      "loading your profile"
    );
    if (error) {
      return { status: "profile-unreachable", userId: authUserId, error };
    }
    if (!data || !data.active) {
      return { status: "inactive-or-missing", userId: authUserId };
    }
    return { status: "active", profile: data as RemoteProfile };
  } catch (error) {
    return {
      status: "profile-unreachable",
      userId: authUserId,
      error: error instanceof Error ? error : new Error("Unable to verify your profile.")
    };
  }
}

export async function fetchProfiles(): Promise<User[]> {
  const supabase = getSupabase();
  const { data, error } = await withRemoteTimeout(
    supabase
      .from("profiles")
      .select("id, name, username, role, active")
      .order("name", { ascending: true }),
    "loading staff profiles"
  );
  if (error) {
    throw error;
  }
  cachedProfiles = data as RemoteProfile[];
  return cachedProfiles.map(mapProfileToUser);
}

export async function loadRemoteAppData(): Promise<AppData> {
  return (await loadRemoteAppDataSnapshot()).appData;
}

export async function loadRemoteAppDataSnapshot(): Promise<RemoteAppDataSnapshot> {
  const supabase = getSupabase();
  const [users, appStateResult] = await Promise.all([
    fetchProfiles(),
    withRemoteTimeout(
      supabase.from("app_state").select("id, data, version").eq("id", "primary").maybeSingle(),
      "loading app data"
    )
  ]);
  if (appStateResult.error && appStateResult.error.code !== "PGRST116") {
    throw appStateResult.error;
  }
  const row = appStateResult.data as RemoteAppStateRow | null;
  cachedProfiles = users.map((user) => ({
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    active: user.active
  }));
  return snapshotFromAppStateRow(row);
}

export async function loadRemoteAppStateMetadata(): Promise<RemoteAppStateMetadata> {
  const supabase = getSupabase();
  const { data, error } = await withRemoteTimeout(
    supabase.from("app_state").select("id, version, updated_at").eq("id", "primary").maybeSingle(),
    "loading app data version"
  );
  if (error && error.code !== "PGRST116") {
    throw error;
  }
  const row = data as RemoteAppStateMetadataRow | null;
  return {
    version: row?.version ?? 0,
    updatedAt: row?.updated_at ?? undefined
  };
}

export async function saveRemoteAppData(
  appData: AppData,
  activeUserId: string,
  expectedVersion: number,
  telemetryOptions: SaveRemoteTelemetryOptions = {}
): Promise<number> {
  const supabase = getSupabase();
  const startedAt = Date.now();
  const sanitizedAppData = sanitizeAppData(appData);
  const { data, error } = await withRemoteTimeout(
    supabase
      .from("app_state")
      .update({
        data: sanitizedAppData,
        updated_by: activeUserId,
        version: expectedVersion + 1
      })
      .eq("id", "primary")
      .eq("version", expectedVersion)
      .select("version")
      .maybeSingle(),
    "saving app data"
  );
  if (error) {
    recordAppStateSaveTelemetry({
      appData: sanitizedAppData,
      actionLabel: telemetryOptions.actionLabel,
      source: telemetryOptions.source ?? "blocking",
      expectedVersion,
      startedAt,
      status: "error",
      errorMessage: error.message,
      pendingOperationCount: telemetryOptions.pendingOperationCount
    });
    throw error;
  }
  if (!data) {
    recordAppStateSaveTelemetry({
      appData: sanitizedAppData,
      actionLabel: telemetryOptions.actionLabel,
      source: telemetryOptions.source ?? "blocking",
      expectedVersion,
      startedAt,
      status: "conflict",
      errorMessage: "Remote data changed in another browser.",
      pendingOperationCount: telemetryOptions.pendingOperationCount
    });
    throw new Error("Remote data changed in another browser. Refreshing latest data.");
  }
  recordAppStateSaveTelemetry({
    appData: sanitizedAppData,
    actionLabel: telemetryOptions.actionLabel,
    source: telemetryOptions.source ?? "blocking",
    expectedVersion,
    nextVersion: data.version as number,
    startedAt,
    status: "success",
    pendingOperationCount: telemetryOptions.pendingOperationCount
  });
  return data.version as number;
}

export function subscribeToRemoteAppData(onChange: (snapshot: RemoteAppDataSnapshot) => void): () => void {
  const supabase = getSupabase();
  const channel: RealtimeChannel = supabase
    .channel("app-state-sync")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "app_state",
        filter: "id=eq.primary"
      },
      async (payload: RealtimePostgresChangesPayload<RemoteAppStateRow>) => {
        if (!("data" in payload.new)) {
          return;
        }
        try {
          await fetchProfiles();
        } catch {
          // Keep applying operational updates even if the small profile refresh fails.
        }
        recordRealtimeSnapshotTelemetry({ appData: payload.new.data, version: payload.new.version });
        onChange(snapshotFromAppStateRow(payload.new));
      }
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}

export async function adminCreateUserRemote(payload: Required<Pick<AdminUserPayload, "name" | "username" | "role" | "password">>): Promise<void> {
  await invokeProtectedFunction("admin-create-user", payload);
}

export async function adminUpdateUserRemote(payload: Required<Pick<AdminUserPayload, "id" | "name" | "username" | "role">>): Promise<void> {
  await invokeProtectedFunction("admin-update-user", payload);
}

export async function adminChangePasswordRemote(userId: string, password: string): Promise<void> {
  await invokeProtectedFunction("admin-change-password", { userId, password });
}

export async function adminToggleUserActiveRemote(userId: string): Promise<void> {
  await invokeProtectedFunction("admin-toggle-user-active", { userId });
}

export async function changeOwnPasswordRemote(password: string): Promise<void> {
  await invokeProtectedFunction("change-own-password", { password });
}

async function invokeProtectedFunction(functionName: string, body: Record<string, unknown>): Promise<void> {
  const supabase = getSupabase();
  const {
    data: { session }
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error("Your session expired. Sign in again.");
  }

  const { error } = await withRemoteTimeout(
    supabase.functions.invoke(functionName, {
      body,
      headers: {
        Authorization: `Bearer ${session.access_token}`
      }
    }),
    "calling the server function"
  );

  if (error) {
    throw new Error(await resolveFunctionErrorMessage(error));
  }
}

async function resolveFunctionErrorMessage(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const payload = await error.context.json();
      if (payload && typeof payload.error === "string" && payload.error.trim()) {
        return payload.error;
      }
    } catch {
      // Ignore JSON parsing errors and fall back below.
    }
    return "The server rejected this request.";
  }

  if (error instanceof FunctionsRelayError || error instanceof FunctionsFetchError) {
    return error.message || "Unable to reach the server function.";
  }

  return error instanceof Error ? error.message : "Unexpected server error.";
}
