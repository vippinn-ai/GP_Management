import {
  createClient,
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
  type RealtimeChannel,
  type SupabaseClient
} from "@supabase/supabase-js";
import type { AppData, Role, User } from "./types";
import { hydrateAppData } from "./storage";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

interface LoginEmailResponse {
  email: string;
}

interface AdminUserPayload {
  id?: string;
  name: string;
  username: string;
  role: Role;
  password?: string;
}

interface RemoteAppStateRow {
  id: string;
  data: Partial<AppData> | null;
  version?: number | null;
}

export interface RemoteProfile {
  id: string;
  name: string;
  username: string;
  role: Role;
  active: boolean;
}

export interface RemoteAppDataSnapshot {
  appData: AppData;
  version: number;
}

let supabaseClient: SupabaseClient | null = null;

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

export function isBackendConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

export async function signInWithUsername(username: string, password: string): Promise<RemoteProfile> {
  const supabase = getSupabase();
  const { data: emailLookup, error: emailLookupError } = await supabase.functions.invoke<LoginEmailResponse>(
    "resolve-login-email",
    {
      body: { username: username.trim() }
    }
  );
  if (emailLookupError || !emailLookup?.email) {
    throw new Error("Invalid username or password.");
  }
  const { error } = await supabase.auth.signInWithPassword({
    email: emailLookup.email,
    password
  });
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
  const supabase = getSupabase();
  const {
    data: { session }
  } = await supabase.auth.getSession();
  const authUserId = session?.user?.id;
  if (!authUserId) {
    return null;
  }
  const { data, error } = await supabase
    .from("profiles")
    .select("id, name, username, role, active")
    .eq("id", authUserId)
    .maybeSingle();
  if (error || !data) {
    return null;
  }
  return data as RemoteProfile;
}

export async function fetchProfiles(): Promise<User[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, name, username, role, active")
    .order("name", { ascending: true });
  if (error) {
    throw error;
  }
  return (data as RemoteProfile[]).map(mapProfileToUser);
}

export async function loadRemoteAppData(): Promise<AppData> {
  return (await loadRemoteAppDataSnapshot()).appData;
}

export async function loadRemoteAppDataSnapshot(): Promise<RemoteAppDataSnapshot> {
  const supabase = getSupabase();
  const [users, appStateResult] = await Promise.all([
    fetchProfiles(),
    supabase.from("app_state").select("id, data, version").eq("id", "primary").maybeSingle()
  ]);
  if (appStateResult.error && appStateResult.error.code !== "PGRST116") {
    throw appStateResult.error;
  }
  const row = appStateResult.data as RemoteAppStateRow | null;
  return {
    appData: hydrateAppData({
      ...(row?.data ?? {}),
      users
    }),
    version: row?.version ?? 0
  };
}

export async function saveRemoteAppData(
  appData: AppData,
  activeUserId: string,
  expectedVersion: number
): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("app_state")
    .update({
      data: sanitizeAppData(appData),
      updated_by: activeUserId,
      version: expectedVersion + 1
    })
    .eq("id", "primary")
    .eq("version", expectedVersion)
    .select("version")
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    throw new Error("Remote data changed in another browser. Refreshing latest data.");
  }
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
      async () => {
        const nextState = await loadRemoteAppDataSnapshot();
        onChange(nextState);
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

async function invokeProtectedFunction(functionName: string, body: Record<string, unknown>): Promise<void> {
  const supabase = getSupabase();
  const {
    data: { session }
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error("Your session expired. Sign in again.");
  }

  const { error } = await supabase.functions.invoke(functionName, {
    body,
    headers: {
      Authorization: `Bearer ${session.access_token}`
    }
  });

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
