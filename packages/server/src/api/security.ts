import type { AppInstance } from './types.js';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",

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

export const RAW_CONTENT_CSP = "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'";
