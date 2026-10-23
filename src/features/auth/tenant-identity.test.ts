import { describe, expect, it, vi } from "vitest";
import { authorizeTenantAdmin, getTenantRuntimeSession } from "./tenant-identity";

const env = {
  R5I_TENANT_PUBLIC_KEY: `pk_${"c".repeat(32)}`,
  API_SERVICE: {
    fetch: vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname.endsWith("/authorize")) {
        return Response.json({
          success: true,
          data: { allowed: true, role: "owner", platformOperator: false },
        });
      }
      return Response.json({
        success: true,
        data: {
          authenticated: true,
          user: { id: "user-1", email: "owner@example.com" },
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      });
    }),
  },
};

describe("tenant identity facade", () => {
  it("reads the host-only identity session and carries the browser cookie", async () => {
    const request = new Request("https://shop.example/admin", {
      headers: { cookie: "r5i_session=abc" },
    });

    const session = await getTenantRuntimeSession(request, env);

    expect(session.authenticated).toBe(true);
    expect(session.user?.email).toBe("owner@example.com");
    const sent = env.API_SERVICE.fetch.mock.calls[0]?.[0];
    expect(sent?.headers.get("cookie")).toBe("r5i_session=abc");
    expect(new URL(sent!.url).pathname).toBe("/public/v1/runtime/session");
  });

  it("requests a fixed store-management action without accepting caller-selected identity", async () => {
    const decision = await authorizeTenantAdmin(
      new Request("https://shop.example/admin/products"),
      env,
    );

    expect(decision).toMatchObject({ allowed: true, role: "owner" });
    const sent = env.API_SERVICE.fetch.mock.calls.at(-1)?.[0];
    expect(await sent?.json()).toEqual({ action: "tenant.admin.store.manage" });
    expect(sent?.headers.get("origin")).toBe("https://shop.example");
  });
});
