export const agentPermissionScopes = [
  "agent:invoke",
  "agent:discover",
  "memory:read",
  "memory:write",
  "task:execute",
  "task:dispatch",
  "data:read",
  "data:write",
] as const;

export type AgentPermission = (typeof agentPermissionScopes)[number];

export interface PermissionGrant {
  permission: AgentPermission;
  resource?: string;
}

export function hasPermission(
  grants: AgentPermission[] | PermissionGrant[],
  permission: AgentPermission,
  resource?: string,
): boolean {
  if (typeof grants[0] === "string") {
    return (grants as AgentPermission[]).includes(permission);
  }

  return (grants as PermissionGrant[]).some(
    (grant) => grant.permission === permission && (grant.resource === undefined || grant.resource === resource),
  );
}
