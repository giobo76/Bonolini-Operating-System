import { createClient } from "./server";
import type { Profile, Role } from "./types";

export async function getSession() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, tenant_id, role, full_name")
    .eq("id", user.id)
    .single();

  if (!profile) return null;

  return {
    user,
    profile: {
      id: profile.id,
      tenantId: profile.tenant_id,
      role: profile.role,
      fullName: profile.full_name,
    } satisfies Profile,
  };
}

export async function getCurrentTenant() {
  const session = await getSession();
  return session?.profile.tenantId ?? null;
}

export async function requireRole(...allowed: Role[]) {
  const session = await getSession();
  if (!session || !allowed.includes(session.profile.role)) {
    throw new Error("Not authorized");
  }
  return session;
}
