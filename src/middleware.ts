import { defineMiddleware } from 'astro:middleware';
import type { APIContext, MiddlewareNext } from 'astro';
import { env } from 'cloudflare:workers';
import { tenantApiFetch } from './features/auth/tenant-api';
import {
  authorizeTenantAdmin,
  getTenantRuntimeSession,
  type TenantAuthorizationDecision,
  type TenantRuntimeSession,
} from './features/auth/tenant-identity';
import {
  getStoreSettings,
  parseStoreSettings,
  STORE_SETTINGS_SQL,
} from './features/settings/db';
import {
  MENU_ITEMS_SQL,
  EMPTY_MENUS,
  groupMenus,
  type MenuItemRow,
} from './features/navigation/db';
import {
  checkRateLimit,
  rateLimitBucket,
  rateLimitedResponse,
} from './features/auth/rateLimit';
import {
  responseCacheControl,
} from './features/cache/public';
import { addCacheTags, responseCacheTags } from './features/cache/tags';
import { normalizeSearchQuery } from './features/search/query';
import { isForbiddenFormOrigin } from './features/auth/formOrigin';

/**
 * Admin auth gate. The shared API gateway validates the host-only identity session and the
 * authorization service checks the store-management action for the resolved tenant.
 * Local `astro dev` remains open so storefront work does not need a tenant registration.
 */
function isProtected(pathname: string): boolean {
  return (
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/api/admin' ||
    pathname.startsWith('/api/admin/')
  );
}

async function gate(context: APIContext, next: MiddlewareNext): Promise<Response> {
  // Runtime settings overlay (store name etc.) — only for HTML page requests, so
  // the storefront/admin can reflect wizard-set values without a redeploy. APIs and
  // static assets skip it (one indexed D1 read per page, not per asset/API call).
  const path = context.url.pathname;
  const isDocument =
    !path.startsWith('/api/') &&
    !path.startsWith('/_') &&
    !path.startsWith('/partials/');
  if (isDocument) {
    // Storefront documents also need the header/footer menus. Both reads go in
    // ONE batch so /cart, /checkout, /account, /order, and /pay — which are never
    // edge-cached — don't pay a second D1 round trip.
    const wantsMenus = !path.startsWith('/admin');
    try {
      if (wantsMenus) {
        const [settings, menus] = await env.DB.batch<Record<string, string>>([
          env.DB.prepare(STORE_SETTINGS_SQL),
          env.DB.prepare(MENU_ITEMS_SQL),
        ]);
        context.locals.settings = parseStoreSettings(
          (settings.results ?? []) as Array<{ key: string; value: string }>,
        );
        context.locals.menus = groupMenus(
          (menus.results ?? []) as unknown as MenuItemRow[],
          context.locals.settings.homePage,
        );
      } else {
        context.locals.settings = await getStoreSettings(env.DB);
      }
    } catch {
      // A batch is all-or-nothing, so a missing `menu_items` table (pre-migration)
      // would take settings down with it — and losing settings silently
      // disables the first-run setup funnel below. Retry settings alone.
      // Empty menus render a bare header and a copyright-only footer: degraded
      // but navigable. Losing settings is not.
      try {
        context.locals.settings = await getStoreSettings(env.DB);
        context.locals.menus = EMPTY_MENUS;
      } catch {
        // Settings table missing too → fall back to build-time defaults.
      }
    }
  }

  // First-run funnel: until the setup wizard is finished, send the STOREFRONT to it
  // too — the admin already redirects /admin → /admin/setup the same way. Skips
  // /admin (its own gate), /api, and assets to avoid loops; only fires once settings
  // loaded and setup_complete isn't set.
  if (
    isDocument &&
    !path.startsWith('/admin') &&
    context.locals.settings &&
    !context.locals.settings.setupComplete
  ) {
    return context.redirect('/admin/setup', 302);
  }

  // Throttle anonymous, resource-spending mutations and cache-missing searches.
  // Webhooks are excluded: providers retry them and signatures are verified.
  const bucket = rateLimitBucket(
    context.request.method,
    path,
    normalizeSearchQuery(context.url.searchParams.get('q') ?? '') !== '',
  );
  if (bucket) {
    const limiter =
      bucket === 'auth'
        ? env.AUTH_RATE_LIMITER
        : bucket === 'checkout'
          ? env.CHECKOUT_RATE_LIMITER
          : env.SEARCH_RATE_LIMITER;
    try {
      if (!(await checkRateLimit(limiter, context.request, path))) {
        console.warn(JSON.stringify({ event: 'rate_limited', bucket, path }));
        return rateLimitedResponse(path);
      }
    } catch (error) {
      // A limiter outage must not make checkout or login unavailable. Binding
      // failures remain visible in Workers Logs for operational follow-up.
      console.error(
        JSON.stringify({
          event: 'rate_limit_error',
          bucket,
          path,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  if (
    path === '/admin/v1/auth/magic-link' ||
    path === '/admin/v1/auth/verify' ||
    path === '/admin/v1/auth/logout'
  ) {
    return tenantApiFetch(context.request, env);
  }

  if (!isProtected(context.url.pathname)) return next();

  // Local Astro development has no deployed tenant registry or identity service.
  if (import.meta.env.DEV) return next();

  const preserveIdentityCookies = (response: Response): void => {
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) {
      context.locals.identitySetCookies = [
        ...(context.locals.identitySetCookies ?? []),
        ...cookies,
      ];
    }
  };

  let session: TenantRuntimeSession;
  try {
    session = await getTenantRuntimeSession(context.request, env, preserveIdentityCookies);
  } catch {
    if (path === '/admin/login') {
      context.locals.authServiceUnavailable = true;
      return next();
    }
    return new Response('Identity service unavailable.', { status: 503 });
  }

  if (!session.authenticated || !session.user) {
    if (path === '/admin/login') return next();
    if (path.startsWith('/api/')) {
      return new Response('Authentication required.', { status: 401 });
    }
    return context.redirect('/admin/login', 303);
  }

  let authorization: TenantAuthorizationDecision;
  try {
    authorization = await authorizeTenantAdmin(context.request, env, preserveIdentityCookies);
  } catch {
    return new Response('Authorization service unavailable.', { status: 503 });
  }

  if (!authorization.allowed || !['owner', 'manager'].includes(authorization.role ?? '')) {
    if (path === '/admin/login') {
      context.locals.authServiceUnavailable = false;
      return next();
    }
    return new Response('Access denied.', { status: 403 });
  }

  context.locals.adminEmail = session.user.email;
  context.locals.adminAuthenticated = true;
  if (path === '/admin/login') return context.redirect('/admin', 303);
  return next();
}

async function route(context: APIContext, next: MiddlewareNext): Promise<Response> {
  const path = context.url.pathname;
  const productError = path.startsWith('/products/') && context.url.searchParams.has('error');

  let response = isForbiddenFormOrigin(context.request, context.url)
    ? new Response(`Cross-site ${context.request.method} form submissions are forbidden`, {
        status: 403,
      })
    : await gate(context, next);

  const identityCookies = context.locals.identitySetCookies ?? [];
  if (identityCookies.length > 0) {
    const headers = new Headers(response.headers);
    for (const cookie of identityCookies) headers.append('Set-Cookie', cookie);
    response = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  // Workers Caching heuristically stores headerless responses, so make every
  // response explicit: only allowlisted public successes/301s are shared.
  const cacheControl = responseCacheControl(
    path,
    response.status,
    response.headers.get('cache-control'),
    productError,
  );
  if (response.headers.get('cache-control') !== cacheControl) {
    try {
      response.headers.set('cache-control', cacheControl);
    } catch {
      // Redirect responses can have immutable headers.
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
      response.headers.set('cache-control', cacheControl);
    }
  }

  const cacheTags = responseCacheTags(path, response.status);
  if (cacheTags.length > 0) {
    try {
      addCacheTags(response.headers, cacheTags);
    } catch {
      // A route-specific response can have immutable headers even when its
      // Cache-Control already matched. Rebuild before adding purge metadata.
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
      addCacheTags(response.headers, cacheTags);
    }
  }

  return response;
}

// Response hardening for a store on a real domain. Applied to EVERY response.
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff', // don't MIME-sniff responses
  'x-frame-options': 'DENY', // block framing (clickjacking) — nothing here is meant to be embedded
  'strict-transport-security': 'max-age=31536000; includeSubDomains', // force HTTPS for a year
};

/** Add the security headers, rebuilding when the response's headers are immutable
 *  (e.g. a Response.redirect to a payment provider, or a Cache API hit). */
function withSecurityHeaders(res: Response): Response {
  try {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  } catch {
    const rebuilt = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: new Headers(res.headers),
    });
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) rebuilt.headers.set(k, v);
    return rebuilt;
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  return withSecurityHeaders(await route(context, next));
});
