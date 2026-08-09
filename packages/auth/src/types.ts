export type Role = "admin" | "dispatcher" | "driver" | "client";

export interface Profile {
  id: string;
  tenantId: string;
  role: Role;
  fullName: string | null;
}
