import type { AppInstance } from './types.js';

/**
 * Security headers.
 *
 * The Content-Security-Policy is restrictive on purpose: the SPA is served from the same
 * origin and must work on an isolated network with no CDN, so there is no need for any
 * remote source. `frame-ancestors 'none'` stops the UI from being click-jacked, and
 * `default-src 'self'` means stored page content can never pull in a third-party asset
 * even if it were rendered (it is not: stored HTML is displayed as escaped text).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // The bundled SPA is fully external-free, so no unsafe-inline/unsafe-eval is needed.
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src 'none'",
  "media-src 'none'",
  "child-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

export interface SecurityHeaderOptions {
  /** Set when the deployment is known to be served over HTTPS. */
  hsts: boolean;
  contentSecurityPolicy?: string;
}

export async function registerSecurityHeaders(
  app: AppInstance,
  options: SecurityHeaderOptions,
): Promise<void> {
  const csp = options.contentSecurityPolicy ?? CONTENT_SECURITY_POLICY;

  app.addHook('onSend', async (_request, reply, payload) => {
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('x-frame-options', 'DENY');
    void reply.header('referrer-policy', 'same-origin');
    // Respect a stricter CSP set by the route itself. The raw-artefact endpoints serve
    // captured third-party content and pin `default-src 'none'; sandbox`; overwriting that
    // with the app-wide policy would be exactly the wrong default.
    if (!reply.hasHeader('content-security-policy')) {
      void reply.header('content-security-policy', csp);
    }
    void reply.header(
      'permissions-policy',
      'geolocation=(), camera=(), microphone=(), interest-cohort=()',
    );
    void reply.header('cross-origin-opener-policy', 'same-origin');
    void reply.header('cross-origin-resource-policy', 'same-origin');
    void reply.header('x-permitted-cross-domain-policies', 'none');
    if (options.hsts) {
      void reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });
}

/**
 * A much stricter CSP for the one endpoint that returns stored page HTML.
 *
 * The body is served as `text/plain` and `X-Content-Type-Options: nosniff` prevents a
 * browser from ever sniffing it into HTML, but the extra policy makes the intent
 * unambiguous: this response must not be able to run script or load anything.
 */
export const RAW_CONTENT_CSP = "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'";
