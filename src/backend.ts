import {
  createClient,
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
}

export interface RemoteProfile {
  id: string;
  name: string;
  username: string;
  role: Role;
  active: boolean;
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
  const supabase = getSupabase();
  const [users, appStateResult] = await Promise.all([
    fetchProfiles(),
    supabase.from("app_state").select("id, data").eq("id", "primary").maybeSingle()
  ]);
  if (appStateResult.error && appStateResult.error.code !== "PGRST116") {
    throw appStateResult.error;
  }
  const row = appStateResult.data as RemoteAppStateRow | null;
  return hydrateAppData({
    ...(row?.data ?? {}),
    users
  });
}

export async function saveRemoteAppData(appData: AppData, activeUserId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("app_state").upsert(
    {
      id: "primary",
      data: sanitizeAppData(appData),
      updated_by: activeUserId
    },
    { onConflict: "id" }
  );
  if (error) {
    throw error;
  }
}

export function subscribeToRemoteAppData(onChange: (appData: AppData) => void): () => void {
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
        const nextState = await loadRemoteAppData();
        onChange(nextState);
      }
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}

export async function adminCreateUserRemote(payload: Required<Pick<AdminUserPayload, "name" | "username" | "role" | "password">>): Promise<void> {
  const { error } = await getSupabase().functions.invoke("admin-create-user", {
    body: payload
  });
  if (error) {
    throw error;
  }
}

export async function adminUpdateUserRemote(payload: Required<Pick<AdminUserPayload, "id" | "name" | "username" | "role">>): Promise<void> {
  const { error } = await getSupabase().functions.invoke("admin-update-user", {
    body: payload
  });
  if (error) {
    throw error;
  }
}

export async function adminChangePasswordRemote(userId: string, password: string): Promise<void> {
  const { error } = await getSupabase().functions.invoke("admin-change-password", {
    body: { userId, password }
  });
  if (error) {
    throw error;
  }
}

export async function adminToggleUserActiveRemote(userId: string): Promise<void> {
  const { error } = await getSupabase().functions.invoke("admin-toggle-user-active", {
    body: { userId }
  });
  if (error) {
    throw error;
  }
}
