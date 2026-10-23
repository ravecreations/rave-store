import { describe, expect, it, vi } from "vitest";
import { tenantApiFetch } from "./tenant-api";

describe("tenant API forwarding", () => {
  it("preserves the site's cookie and origin when using the service binding", async () => {
    let captured: Request | undefined;
    const env = {
      R5I_TENANT_PUBLIC_KEY: `pk_${"a".repeat(32)}`,
      API_SERVICE: {
        fetch: vi.fn(async (request: Request) => {
          captured = request;
          return new Response("ok");
        }),
      },
    };
    const original = new Request("https://shop.example/admin/v1/auth/verify?token=abc", {
      headers: { cookie: "r5i_session=session-value" },
    });

    const response = await tenantApiFetch(original, env);

    expect(response.status).toBe(200);
    expect(captured?.url).toBe("https://shop.example/admin/v1/auth/verify?token=abc");
    expect(captured?.headers.get("origin")).toBe("https://shop.example");
    expect(captured?.headers.get("cookie")).toBe("r5i_session=session-value");
    expect(captured?.headers.get("x-r5i-public-key")).toBe(env.R5I_TENANT_PUBLIC_KEY);
  });

  it("targets the public API gateway for standalone deployments", async () => {
    const fetcher = vi.fn(async (request: Request | URL) => new Response(request.toString()));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetcher as typeof fetch;
    try {
      const original = new Request("https://shop.example/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@example.com" }),
      });
      await tenantApiFetch(original, { R5I_TENANT_PUBLIC_KEY: `pk_${"b".repeat(32)}` }, "/admin/v1/auth/magic-link");
      const captured = fetcher.mock.calls[0]?.[0];
      expect(captured instanceof Request ? captured.url : captured?.toString()).toBe(
        "https://api.r5.industries/admin/v1/auth/magic-link",
      );
      expect(captured instanceof Request ? captured.headers.get("origin") : null).toBe(
        "https://shop.example",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed when the tenant selector is not configured", async () => {
    const response = await tenantApiFetch(new Request("https://shop.example/admin"), {});
    expect(response.status).toBe(503);
  });
});
