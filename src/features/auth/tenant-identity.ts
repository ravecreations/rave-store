import { tenantApiFetch, type TenantApiEnvironment } from "./tenant-api";

export interface TenantRuntimeSession {
  readonly authenticated: boolean;
  readonly user: { readonly id: string; readonly email: string } | null;
  readonly expiresAt: string | null;
}

export interface TenantAuthorizationDecision {
  readonly allowed: boolean;
  readonly role: "owner" | "manager" | "staff" | "developer" | null;
  readonly platformOperator: boolean;
}

interface ApiEnvelope<T> {
  readonly success: boolean;
  readonly data?: T;
}

async function readEnvelope<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Tenant identity service returned ${response.status}`);
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null || !("success" in payload)) {
    throw new Error("Tenant identity service returned an invalid response");
  }
  const envelope = payload as ApiEnvelope<T>;
  if (!envelope.success || !("data" in envelope)) {
    throw new Error("Tenant identity service rejected the request");
  }
  return envelope.data as T;
}

export async function getTenantRuntimeSession(
  request: Request,
  env: TenantApiEnvironment,
  onResponse?: (response: Response) => void,
): Promise<TenantRuntimeSession> {
  const response = await tenantApiFetch(request, env, "/public/v1/runtime/session", {
    method: "GET",
  });
  onResponse?.(response);
  return readEnvelope<TenantRuntimeSession>(response);
}

export async function authorizeTenantAdmin(
  request: Request,
  env: TenantApiEnvironment,
  onResponse?: (response: Response) => void,
): Promise<TenantAuthorizationDecision> {
  const response = await tenantApiFetch(request, env, "/public/v1/runtime/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "tenant.admin.store.manage" }),
  });
  onResponse?.(response);
  return readEnvelope<TenantAuthorizationDecision>(response);
}
