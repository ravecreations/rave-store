import { readBoundedText } from "../http/requestBody";

const PUBLIC_TENANT_KEY_HEADER = "x-r5i-public-key";
const PUBLIC_KEY_PATTERN = /^pk_[A-Za-z0-9_-]{32,128}$/;
const API_GATEWAY_ORIGIN = "https://api.r5.industries";
const MAX_AUTH_BODY_BYTES = 32 * 1024;

export interface TenantApiBinding {
  fetch(request: Request): Promise<Response>;
}

export interface TenantApiEnvironment {
  readonly API_SERVICE?: TenantApiBinding;
  readonly R5I_TENANT_PUBLIC_KEY?: string;
}

/** Forward this site's request through the shared tenant API gateway. */
export async function tenantApiFetch(
  request: Request,
  env: TenantApiEnvironment,
  targetPath?: string,
  init?: RequestInit,
): Promise<Response> {
  const publicKey = env.R5I_TENANT_PUBLIC_KEY?.trim();
  if (!publicKey || !PUBLIC_KEY_PATTERN.test(publicKey)) {
    return new Response("Tenant identity service is not configured.", { status: 503 });
  }

  const sourceUrl = new URL(request.url);
  const path = targetPath ?? sourceUrl.pathname;
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("Tenant API paths must remain on the configured gateway");
  }

  const origin = sourceUrl.origin;
  const gatewayOrigin = env.API_SERVICE ? origin : API_GATEWAY_ORIGIN;
  const targetUrl = new URL(path, gatewayOrigin);
  if (targetUrl.origin !== gatewayOrigin) {
    throw new TypeError("Tenant API paths must remain on the configured gateway");
  }
  if (!targetPath) targetUrl.search = sourceUrl.search;
  const headers = new Headers(request.headers);
  for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
  headers.set(PUBLIC_TENANT_KEY_HEADER, publicKey);
  headers.set("Origin", origin);
  headers.delete("content-length");

  const method = (init?.method ?? request.method).toUpperCase();
  let body = init?.body;
  if (!(init && "body" in init) && method !== "GET" && method !== "HEAD" && request.body) {
    const text = await readBoundedText(request, MAX_AUTH_BODY_BYTES).catch(() => undefined);
    if (text === null) return new Response("Authentication request is too large.", { status: 413 });
    if (text === undefined) return new Response("Invalid authentication request.", { status: 400 });
    body = text;
  }
  const forwarded = new Request(targetUrl, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    redirect: "manual",
  });

  return env.API_SERVICE ? env.API_SERVICE.fetch(forwarded) : fetch(forwarded);
}
