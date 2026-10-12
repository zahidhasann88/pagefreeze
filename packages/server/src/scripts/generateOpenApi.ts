import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { VERSION } from '@pagefreeze/shared';
import {
  apiTokenCreateSchema,
  channelCreateSchema,
  channelUpdateSchema,
  changeListQuerySchema,
  compareQuerySchema,
  errorResponseSchema,
  loginSchema,
  monitorCreateSchema,
  monitorListQuerySchema,
  monitorUpdateSchema,
  shareCreateSchema,
  snapshotListQuerySchema,
} from '@pagefreeze/shared';
import { channelTestSchema } from '@pagefreeze/shared';
import { toYaml } from './yaml.js';

/**
 * Generate `api/openapi.yaml`.
 *
 * Request and query schemas are derived from the same zod schemas the server validates
 * with (`z.toJSONSchema(schema, { io: 'input' })`), so the specification cannot drift from
 * the runtime behaviour for those. Response bodies are described by hand: they are read
 * paths whose shape is decided by the row mappers, and pretending to derive them would
 * only add indirection.
 *
 * Run with `pnpm openapi`. CI fails if the committed file differs from the generated one.
 */

type Json = Record<string, unknown>;

/** Convert a zod schema into an OpenAPI-compatible JSON Schema fragment. */
function fromZod(schema: z.ZodType, options: { io?: 'input' | 'output' } = {}): Json {
  const json = z.toJSONSchema(schema, { io: options.io ?? 'input' }) as Json;
  delete json['$schema'];
  return json;
}

function queryParameters(schema: z.ZodType): Json[] {
  const json = fromZod(schema, { io: 'input' });
  const properties = (json['properties'] ?? {}) as Record<string, Json>;
  const required = new Set((json['required'] ?? []) as string[]);

  return Object.entries(properties).map(([name, definition]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema: definition,
  }));
}

function pathParameter(name: string, description: string): Json {
  return {
    name,
    in: 'path',
    required: true,
    description,
    schema: { type: 'string', format: 'uuid' },
  };
}

const jsonBody = (schemaRef: string, description?: string): Json => ({
  required: true,
  ...(description ? { description } : {}),
  content: { 'application/json': { schema: { $ref: schemaRef } } },
});

const jsonResponse = (schema: Json | string, description: string): Json => ({
  description,
  content: {
    'application/json': { schema: typeof schema === 'string' ? { $ref: schema } : schema },
  },
});

const pngResponse = (description: string): Json => ({
  description,
  content: { 'image/png': { schema: { type: 'string', format: 'binary' } } },
});

const textResponseSpec = (description: string): Json => ({
  description,
  content: { 'text/plain': { schema: { type: 'string' } } },
});

/** Response shapes, described once and referenced by the paths. */
const responseSchemas: Record<string, Json> = {
  Monitor: {
    type: 'object',
    description: 'A monitor with its capture settings. Secret values are never included.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      url: { type: 'string', format: 'uri' },
      enabled: { type: 'boolean' },
      paused: { type: 'boolean' },
      scheduleKind: { type: 'string', enum: ['preset', 'cron'] },
      scheduleValue: { type: 'string' },
      scheduleCron: { type: 'string', description: 'Effective cron expression.' },
      scheduleDescription: { type: 'string', description: 'Human readable schedule.' },
      nextRunAt: { type: ['string', 'null'], format: 'date-time' },
      devicePreset: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] },
      viewportWidth: { type: 'integer' },
      viewportHeight: { type: 'integer' },
      fullPage: { type: 'boolean' },
      waitStrategy: { type: 'string', enum: ['load', 'networkidle', 'selector'] },
      waitSelector: { type: ['string', 'null'] },
      extraDelayMs: { type: 'integer' },
      captureSelector: { type: ['string', 'null'] },
      ignoreSelectors: { type: 'array', items: { type: 'string' } },
      userAgent: { type: ['string', 'null'] },
      changeThreshold: {
        type: 'number',
        description: 'Percent of differing pixels that counts as significant.',
      },
      detectText: { type: 'boolean' },
      detectHtml: { type: 'boolean' },
      retentionDays: { type: ['integer', 'null'] },
      tags: { type: 'array', items: { type: 'string' } },
      secrets: {
        type: 'object',
        description: 'Names only. Values are encrypted at rest and never returned.',
        properties: {
          headerNames: { type: 'array', items: { type: 'string' } },
          cookieNames: { type: 'array', items: { type: 'string' } },
        },
      },
      channelIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      consecutiveFailures: { type: 'integer' },
      failureNotified: { type: 'boolean' },
      status: { type: 'string', enum: ['ok', 'changed', 'failing', 'paused'] },
      lastRunAt: { type: ['string', 'null'], format: 'date-time' },
      lastSnapshotAt: { type: ['string', 'null'], format: 'date-time' },
      lastChangeAt: { type: ['string', 'null'], format: 'date-time' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  MonitorSummary: {
    type: 'object',
    description: 'Dashboard card payload.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      url: { type: 'string' },
      enabled: { type: 'boolean' },
      paused: { type: 'boolean' },
      status: { type: 'string', enum: ['ok', 'changed', 'failing', 'paused'] },
      tags: { type: 'array', items: { type: 'string' } },
      scheduleDescription: { type: 'string' },
      nextRunAt: { type: ['string', 'null'], format: 'date-time' },
      lastRunAt: { type: ['string', 'null'], format: 'date-time' },
      lastCheckedAt: { type: ['string', 'null'], format: 'date-time' },
      lastChangeAt: { type: ['string', 'null'], format: 'date-time' },
      latestScreenshotUrl: { type: ['string', 'null'] },
      latestSnapshotId: { type: ['string', 'null'], format: 'uuid' },
      recentChangeCount: { type: 'integer' },
      changeSparkline: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Daily change counts, oldest first, 14 buckets.',
      },
      consecutiveFailures: { type: 'integer' },
      changeThreshold: { type: 'number' },
    },
  },
  Snapshot: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      monitorId: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['success', 'failed'] },
      capturedAt: { type: 'string', format: 'date-time' },
      finalUrl: { type: ['string', 'null'] },
      httpStatus: { type: ['integer', 'null'] },
      loadDurationMs: { type: ['integer', 'null'] },
      title: { type: ['string', 'null'] },
      errorMessage: { type: ['string', 'null'] },
      screenshotWidth: { type: ['integer', 'null'] },
      screenshotHeight: { type: ['integer', 'null'] },
      screenshotHash: { type: ['string', 'null'] },
      htmlHash: { type: ['string', 'null'] },
      textHash: { type: ['string', 'null'] },
      duplicateOf: {
        type: ['string', 'null'],
        format: 'uuid',
        description:
          'Set when the content matched an earlier snapshot and no new files were stored.',
      },
      bytes: { type: ['integer', 'null'] },
      changeId: { type: ['string', 'null'], format: 'uuid' },
    },
  },
  DiffRegion: {
    type: 'object',
    description: 'A clustered rectangle of changed pixels, in CSS pixels of the newer screenshot.',
    properties: {
      x: { type: 'integer' },
      y: { type: 'integer' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      weight: { type: 'number', description: 'Share of all changed pixels inside this box (0-1).' },
    },
  },
  Change: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      monitorId: { type: 'string', format: 'uuid' },
      fromSnapshotId: { type: ['string', 'null'], format: 'uuid' },
      toSnapshotId: { type: 'string', format: 'uuid' },
      createdAt: { type: 'string', format: 'date-time' },
      pixelDiffPercent: { type: ['number', 'null'] },
      changedPixels: { type: ['integer', 'null'] },
      totalPixels: { type: ['integer', 'null'] },
      sizeChanged: { type: 'boolean' },
      sizeFrom: {
        type: ['object', 'null'],
        properties: { width: { type: 'integer' }, height: { type: 'integer' } },
      },
      sizeTo: {
        type: ['object', 'null'],
        properties: { width: { type: 'integer' }, height: { type: 'integer' } },
      },
      textAdded: { type: ['integer', 'null'] },
      textRemoved: { type: ['integer', 'null'] },
      htmlAdded: { type: ['integer', 'null'] },
      htmlRemoved: { type: ['integer', 'null'] },
      significant: { type: 'boolean' },
      summary: { type: 'string' },
      regions: { type: 'array', items: { $ref: '#/components/schemas/DiffRegion' } },
      hasDiffImage: { type: 'boolean' },
    },
  },
  ChangeDetail: {
    allOf: [
      { $ref: '#/components/schemas/Change' },
      {
        type: 'object',
        properties: {
          monitor: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: ['string', 'null'] },
              url: { type: ['string', 'null'] },
            },
          },
          navigation: {
            type: 'object',
            description: 'Neighbouring change ids for previous/next navigation.',
            properties: {
              newer: { type: ['string', 'null'], format: 'uuid' },
              older: { type: ['string', 'null'], format: 'uuid' },
            },
          },
          diffImageUrl: { type: ['string', 'null'] },
          screenshotUrls: {
            type: 'object',
            properties: {
              before: { type: ['string', 'null'] },
              after: { type: 'string' },
            },
          },
          textDiff: {
            type: ['object', 'null'],
            description: 'Line and word level text diff with stats and a unified patch.',
          },
          htmlDiff: {
            type: ['object', 'null'],
            description: 'Line diff over normalised HTML, with unchanged runs folded.',
          },
          truncated: { type: 'boolean' },
          shares: { type: 'array', items: { $ref: '#/components/schemas/ShareLink' } },
        },
      },
    ],
  },
  NotificationChannel: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      type: { type: 'string', enum: ['webhook', 'slack', 'email'] },
      enabled: { type: 'boolean' },
      config: {
        type: 'object',
        description: 'Non-secret view only: a webhook signing secret is never returned.',
        additionalProperties: true,
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  ApiToken: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      prefix: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      expiresAt: { type: ['string', 'null'], format: 'date-time' },
      lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
      revokedAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  ApiTokenCreated: {
    allOf: [
      { $ref: '#/components/schemas/ApiToken' },
      {
        type: 'object',
        required: ['token'],
        properties: {
          token: {
            type: 'string',
            description: 'The plaintext token. Returned exactly once, at creation time.',
          },
        },
      },
    ],
  },
  ShareLink: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      changeId: { type: 'string', format: 'uuid' },
      url: { type: 'string', description: 'Absolute, unguessable, read-only URL.' },
      token: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      expiresAt: { type: ['string', 'null'], format: 'date-time' },
      revokedAt: { type: ['string', 'null'], format: 'date-time' },
      viewCount: { type: 'integer' },
      active: { type: 'boolean' },
    },
  },
  JobRef: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['queued', 'inline'] },
      jobId: { type: ['string', 'null'] },
      monitorId: { type: 'string', format: 'uuid' },
      queuedAt: { type: 'string', format: 'date-time' },
    },
  },
  PreviewResult: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      error: { type: ['string', 'null'] },
      title: { type: ['string', 'null'] },
      finalUrl: { type: ['string', 'null'] },
      httpStatus: { type: ['integer', 'null'] },
      loadDurationMs: { type: ['integer', 'null'] },
      width: { type: ['integer', 'null'] },
      height: { type: ['integer', 'null'] },
      bytes: { type: 'integer' },
      screenshotBase64: {
        type: ['string', 'null'],
        description: 'Inline base64 PNG. Null when the screenshot exceeds the preview cap.',
      },
      textPreview: { type: 'string' },
      blockedRequests: {
        type: 'array',
        items: {
          type: 'object',
          properties: { url: { type: 'string' }, reason: { type: 'string' } },
        },
      },
    },
  },
  CompareResult: {
    type: 'object',
    properties: {
      stored: { type: 'boolean' },
      changeId: { type: ['string', 'null'], format: 'uuid' },
      diff: {
        type: 'object',
        properties: {
          pixelDiffPercent: { type: ['number', 'null'] },
          changedPixels: { type: ['integer', 'null'] },
          totalPixels: { type: ['integer', 'null'] },
          sizeChanged: { type: 'boolean' },
          regions: { type: 'array', items: { $ref: '#/components/schemas/DiffRegion' } },
          text: { type: ['object', 'null'] },
          html: { type: ['object', 'null'] },
          significant: { type: 'boolean' },
          durationMs: { type: 'integer' },
        },
      },
    },
  },
  SystemInfo: {
    type: 'object',
    properties: {
      version: { type: 'string' },
      node: { type: 'string' },
      platform: { type: 'string' },
      mode: { type: 'string', enum: ['all', 'api', 'worker'] },
      uptimeSeconds: { type: 'integer' },
      database: {
        type: 'object',
        properties: {
          version: { type: ['string', 'null'] },
          sizeBytes: { type: ['integer', 'null'] },
        },
      },
      storage: {
        type: 'object',
        properties: {
          driver: { type: 'string' },
          snapshots: { type: 'integer' },
          bytes: { type: 'integer' },
        },
      },
      capture: {
        type: 'object',
        properties: {
          concurrency: { type: 'integer' },
          timeoutMs: { type: 'integer' },
          retries: { type: 'integer' },
          browserRunning: { type: 'boolean' },
        },
      },
      retentionDays: { type: 'integer' },
      minIntervalMinutes: { type: 'integer' },
      ssrf: {
        type: 'object',
        properties: {
          allowPrivateTargets: { type: 'boolean' },
          allowedHosts: { type: 'array', items: { type: 'string' } },
        },
      },
      counts: {
        type: 'object',
        properties: {
          monitors: { type: 'integer' },
          snapshots: { type: 'integer' },
          changes: { type: 'integer' },
        },
      },
      scheduler: {
        type: 'object',
        properties: { enabled: { type: 'boolean' }, queueDepth: { type: 'integer' } },
      },
    },
  },
  HealthResponse: {
    type: 'object',
    properties: {
      status: { type: 'string' },
      version: { type: 'string' },
      uptimeSeconds: { type: 'integer' },
    },
  },
  ReadyResponse: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ready', 'not-ready'] },
      checks: { type: 'object', additionalProperties: true },
    },
  },
  MeResponse: {
    type: 'object',
    properties: {
      username: { type: 'string' },
      kind: { type: 'string', enum: ['session', 'token'] },
      csrfToken: { type: ['string', 'null'] },
      permissions: { type: 'array', items: { type: 'string' } },
    },
  },
};

function pageOf(itemRef: string, description: string): Json {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['data', 'nextCursor', 'hasMore'],
          properties: {
            data: { type: 'array', items: { $ref: itemRef } },
            nextCursor: { type: ['string', 'null'], description: 'Opaque keyset cursor.' },
            hasMore: { type: 'boolean' },
          },
        },
      },
    },
  };
}

const errorResponses: Json = {
  400: jsonResponse('#/components/schemas/Error', 'Bad request.'),
  401: jsonResponse('#/components/schemas/Error', 'Not authenticated.'),
  403: jsonResponse('#/components/schemas/Error', 'Forbidden, or CSRF validation failed.'),
  404: jsonResponse('#/components/schemas/Error', 'Not found.'),
  422: jsonResponse(
    '#/components/schemas/Error',
    'Request validation failed. `details` lists the offending fields.',
  ),
  429: jsonResponse('#/components/schemas/Error', 'Rate limited.'),
  500: jsonResponse('#/components/schemas/Error', 'Internal error.'),
};

const authErrorResponses: Json = {
  401: errorResponses[401],
  403: errorResponses[403],
  422: errorResponses[422],
  429: errorResponses[429],
  500: errorResponses[500],
};

export function buildOpenApiDocument(): Json {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Pagefreeze API',
      version: VERSION,
      description: [
        'Self-hosted website change monitoring. Pagefreeze takes scheduled snapshots of web',
        'pages and reports what changed between versions: a pixel diff of the screenshots, a',
        'diff of the visible text, and a diff of the normalised HTML.',
        '',
        '## Authentication',
        '',
        'Two mechanisms are supported:',
        '',
        '- A cookie session, created by `POST /api/v1/auth/login`. Mutating requests made with',
        '  a session cookie must also send the `X-CSRF-Token` header with the value of the',
        '  readable `pagefreeze_csrf` cookie.',
        '- `Authorization: Bearer <token>` for scripts. Tokens are created through',
        '  `POST /api/v1/tokens`, are shown exactly once, and are stored hashed. Bearer',
        '  requests are exempt from the CSRF check because a token is not an ambient',
        '  credential.',
        '',
        '## Pagination',
        '',
        'List endpoints use opaque keyset cursors. Pass `limit` and `cursor`; the response',
        'carries `nextCursor` and `hasMore`. Cursors encode the sort key of the last row, so',
        'they stay stable while new snapshots are written.',
        '',
        '## Errors',
        '',
        'Every error has the shape `{ "error": { "code", "message", "details"? } }`. `code` is',
        'stable and machine readable; `message` is safe to display.',
      ].join('\n'),
      license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
    },
    servers: [{ url: '/', description: 'The self-hosted Pagefreeze instance.' }],
    tags: [
      { name: 'auth', description: 'Sessions and API tokens.' },
      { name: 'monitors', description: 'Monitors and capture control.' },
      { name: 'snapshots', description: 'Captured snapshots and their artefacts.' },
      { name: 'changes', description: 'Diffs between snapshots.' },
      { name: 'channels', description: 'Notification channels.' },
      { name: 'shares', description: 'Public, revocable share links.' },
      { name: 'system', description: 'Health, readiness, metrics and system info.' },
    ],
    security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    paths: {
      '/api/v1/auth/login': {
        post: {
          tags: ['auth'],
          summary: 'Sign in with the admin password',
          description:
            'Creates a session cookie plus a readable CSRF cookie. Rate limited to 10 attempts per 5 minutes per client address.',
          requestBody: jsonBody('#/components/schemas/LoginRequest'),
          responses: {
            200: jsonResponse(
              {
                type: 'object',
                properties: {
                  username: { type: 'string' },
                  csrfToken: { type: ['string', 'null'] },
                },
              },
              'Authenticated.',
            ),
            401: errorResponses[401],
            429: errorResponses[429],
          },
          security: [],
        },
      },
      '/api/v1/auth/logout': {
        post: {
          tags: ['auth'],
          summary: 'End the current session',
          responses: { 204: { description: 'Session ended.' } },
          security: [{ cookieAuth: [] }],
        },
      },
      '/api/v1/auth/me': {
        get: {
          tags: ['auth'],
          summary: 'Describe the current caller',
          responses: {
            200: jsonResponse('#/components/schemas/MeResponse', 'The authenticated principal.'),
            401: errorResponses[401],
          },
        },
      },
      '/api/v1/tokens': {
        get: {
          tags: ['auth'],
          summary: 'List API tokens',
          description:
            'Returns metadata only. Plaintext tokens are never retrievable after creation.',
          responses: {
            200: jsonResponse(
              {
                type: 'object',
                properties: {
                  data: { type: 'array', items: { $ref: '#/components/schemas/ApiToken' } },
                },
              },
              'All tokens, newest first.',
            ),
            ...authErrorResponses,
          },
        },
        post: {
          tags: ['auth'],
          summary: 'Create an API token',
          requestBody: jsonBody('#/components/schemas/ApiTokenCreateRequest'),
          responses: {
            201: jsonResponse(
              '#/components/schemas/ApiTokenCreated',
              'Created. The `token` field is shown once and never again.',
            ),
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/tokens/{id}': {
        delete: {
          tags: ['auth'],
          summary: 'Revoke an API token',
          parameters: [pathParameter('id', 'Token id.')],
          responses: {
            204: { description: 'Revoked.' },
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/monitors': {
        get: {
          tags: ['monitors'],
          summary: 'List monitors as dashboard summaries',
          parameters: queryParameters(monitorListQuerySchema),
          responses: {
            200: pageOf('#/components/schemas/MonitorSummary', 'A page of monitor summaries.'),
            ...authErrorResponses,
          },
        },
        post: {
          tags: ['monitors'],
          summary: 'Create a monitor',
          description:
            'The URL is checked against the SSRF policy before anything is stored, so an operator gets an immediate error rather than a monitor that fails on every run. Custom header and cookie values are encrypted at rest and are never returned.',
          requestBody: jsonBody('#/components/schemas/MonitorCreateRequest'),
          responses: {
            201: jsonResponse('#/components/schemas/Monitor', 'Created.'),
            400: errorResponses[400],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/monitors/preview': {
        post: {
          tags: ['monitors'],
          summary: 'Run a capture without saving anything',
          description:
            'Uses exactly the same capture path as a scheduled run, so the preview reflects what the monitor will produce. Nothing is written to the database or to storage; the screenshot comes back inline as base64.',
          requestBody: jsonBody('#/components/schemas/MonitorCreateRequest'),
          responses: {
            200: jsonResponse('#/components/schemas/PreviewResult', 'Preview outcome.'),
            400: errorResponses[400],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/monitors/{id}': {
        get: {
          tags: ['monitors'],
          summary: 'Fetch one monitor',
          parameters: [pathParameter('id', 'Monitor id.')],
          responses: {
            200: jsonResponse('#/components/schemas/Monitor', 'The monitor.'),
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
        patch: {
          tags: ['monitors'],
          summary: 'Update a monitor',
          description:
            'Partial update. Only the fields present in the body are changed. Changing the schedule re-registers the pg-boss job; disabling or pausing removes it. `scheduleKind` and `scheduleValue` must be sent together.',
          parameters: [pathParameter('id', 'Monitor id.')],
          requestBody: jsonBody('#/components/schemas/MonitorUpdateRequest'),
          responses: {
            200: jsonResponse('#/components/schemas/Monitor', 'The updated monitor.'),
            404: errorResponses[404],
            422: errorResponses[422],
            ...authErrorResponses,
          },
        },
        delete: {
          tags: ['monitors'],
          summary: 'Delete a monitor',
          description: 'Cascades to snapshots, changes, artefacts and channel attachments.',
          parameters: [pathParameter('id', 'Monitor id.')],
          responses: {
            204: { description: 'Deleted.' },
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/monitors/{id}/capture': {
        post: {
          tags: ['monitors'],
          summary: 'Trigger an immediate capture',
          description:
            'Queues a job and returns a reference. In an API-only process with no scheduler the capture runs inline; the response shape is the same either way.',
          parameters: [pathParameter('id', 'Monitor id.')],
          responses: {
            202: jsonResponse('#/components/schemas/JobRef', 'Capture queued or started.'),
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/monitors/{id}/pause': {
        post: {
          tags: ['monitors'],
          summary: 'Pause a monitor',
          description: 'Removes its schedule. History is kept.',
          parameters: [pathParameter('id', 'Monitor id.')],
          responses: {
            200: jsonResponse('#/components/schemas/Monitor', 'The paused monitor.'),
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/monitors/{id}/resume': {
        post: {
          tags: ['monitors'],
          summary: 'Resume a monitor',
          parameters: [pathParameter('id', 'Monitor id.')],
          responses: {
            200: jsonResponse('#/components/schemas/Monitor', 'The resumed monitor.'),
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/monitors/{id}/snapshots': {
        get: {
          tags: ['snapshots'],
          summary: 'List snapshots of a monitor',
          parameters: [
            pathParameter('id', 'Monitor id.'),
            ...queryParameters(snapshotListQuerySchema),
          ],
          responses: {
            200: pageOf('#/components/schemas/Snapshot', 'Newest first.'),
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/monitors/{id}/changes': {
        get: {
          tags: ['changes'],
          summary: 'List changes of a monitor',
          parameters: [
            pathParameter('id', 'Monitor id.'),
            ...queryParameters(changeListQuerySchema),
          ],
          responses: {
            200: pageOf(
              '#/components/schemas/Change',
              'Newest first. Diff bodies are omitted from lists.',
            ),
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/snapshots/{id}': {
        get: {
          tags: ['snapshots'],
          summary: 'Fetch one snapshot',
          parameters: [pathParameter('id', 'Snapshot id.')],
          responses: {
            200: jsonResponse('#/components/schemas/Snapshot', 'The snapshot.'),
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/snapshots/{id}/screenshot': {
        get: {
          tags: ['snapshots'],
          summary: 'Download the screenshot PNG',
          parameters: [pathParameter('id', 'Snapshot id.')],
          responses: {
            200: pngResponse('The captured screenshot.'),
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/snapshots/{id}/html': {
        get: {
          tags: ['snapshots'],
          summary: 'Download the stored rendered HTML',
          description:
            "Served as `text/plain` with `X-Content-Type-Options: nosniff` and a `default-src 'none'; sandbox` CSP. Stored page content is third-party data and is never served as HTML from this origin.",
          parameters: [pathParameter('id', 'Snapshot id.')],
          responses: {
            200: textResponseSpec('The stored HTML as text.'),
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/snapshots/{id}/text': {
        get: {
          tags: ['snapshots'],
          summary: 'Download the extracted visible text',
          parameters: [pathParameter('id', 'Snapshot id.')],
          responses: {
            200: textResponseSpec('The extracted text.'),
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/changes/{id}': {
        get: {
          tags: ['changes'],
          summary: 'Fetch one change with its full diff payload',
          parameters: [pathParameter('id', 'Change id.')],
          responses: {
            200: jsonResponse(
              '#/components/schemas/ChangeDetail',
              'The change, its diffs, and navigation to neighbouring changes.',
            ),
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/changes/{id}/diff-image': {
        get: {
          tags: ['changes'],
          summary: 'Download the pixel diff PNG',
          parameters: [pathParameter('id', 'Change id.')],
          responses: {
            200: pngResponse('Changed pixels highlighted.'),
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/changes/{id}/share': {
        post: {
          tags: ['shares'],
          summary: 'Create a public share link for a change',
          description:
            'Returns an unguessable, read-only, revocable URL. Whoever holds it can see the screenshots, extracted text and HTML diff of both captures - if the monitored page is behind authentication, that may include account-specific data. Treat the URL as a bearer credential.',
          parameters: [pathParameter('id', 'Change id.')],
          requestBody: jsonBody('#/components/schemas/ShareCreateRequest'),
          responses: {
            201: jsonResponse('#/components/schemas/ShareLink', 'Created.'),
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/changes/{id}/shares': {
        get: {
          tags: ['shares'],
          summary: 'List share links for a change',
          parameters: [pathParameter('id', 'Change id.')],
          responses: {
            200: jsonResponse(
              {
                type: 'object',
                properties: {
                  data: { type: 'array', items: { $ref: '#/components/schemas/ShareLink' } },
                },
              },
              'All links for this change.',
            ),
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/shares/{id}': {
        delete: {
          tags: ['shares'],
          summary: 'Revoke a share link',
          parameters: [pathParameter('id', 'Share link id.')],
          responses: {
            204: { description: 'Revoked.' },
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/share/{token}': {
        get: {
          tags: ['shares'],
          summary: 'Read a shared change (public)',
          description: 'No authentication required. Increments the link view counter.',
          parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: jsonResponse('#/components/schemas/ShareView', 'The shared change.'),
            404: errorResponses[404],
          },
          security: [],
        },
      },
      '/api/v1/share/{token}/screenshot/{which}': {
        get: {
          tags: ['shares'],
          summary: 'Read a shared artefact image (public)',
          parameters: [
            { name: 'token', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'which',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: ['before', 'after', 'diff'] },
            },
          ],
          responses: { 200: pngResponse('The image.'), 404: errorResponses[404] },
          security: [],
        },
      },
      '/api/v1/share/{token}/text/{which}': {
        get: {
          tags: ['shares'],
          summary: 'Read shared extracted text (public)',
          parameters: [
            { name: 'token', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'which',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: ['before', 'after'] },
            },
          ],
          responses: { 200: textResponseSpec('The text.'), 404: errorResponses[404] },
          security: [],
        },
      },
      '/api/v1/compare': {
        get: {
          tags: ['changes'],
          summary: 'Compare any two snapshots on demand',
          description:
            'Both snapshots must belong to the same monitor and both must have succeeded. The pair is ordered chronologically, so `a` and `b` may be given in either order. With `store=false` (the default) nothing is written. With `store=true`, cookie-authenticated requests must include X-CSRF-Token because the comparison is saved.',
          parameters: queryParameters(compareQuerySchema),
          responses: {
            200: jsonResponse('#/components/schemas/CompareResult', 'The comparison.'),
            400: errorResponses[400],
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/channels': {
        get: {
          tags: ['channels'],
          summary: 'List notification channels',
          responses: {
            200: jsonResponse(
              {
                type: 'object',
                properties: {
                  data: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/NotificationChannel' },
                  },
                },
              },
              'All channels.',
            ),
            ...authErrorResponses,
          },
        },
        post: {
          tags: ['channels'],
          summary: 'Create a notification channel',
          description:
            'Webhook destinations are checked against the SSRF policy. The signing secret is encrypted at rest and never returned.',
          requestBody: jsonBody('#/components/schemas/ChannelCreateRequest'),
          responses: {
            201: jsonResponse('#/components/schemas/NotificationChannel', 'Created.'),
            400: errorResponses[400],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/channels/{id}': {
        patch: {
          tags: ['channels'],
          summary: 'Update a notification channel',
          parameters: [pathParameter('id', 'Channel id.')],
          requestBody: jsonBody('#/components/schemas/ChannelUpdateRequest'),
          responses: {
            200: jsonResponse('#/components/schemas/NotificationChannel', 'Updated.'),
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
        delete: {
          tags: ['channels'],
          summary: 'Delete a notification channel',
          parameters: [pathParameter('id', 'Channel id.')],
          responses: {
            204: { description: 'Deleted.' },
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/channels/{id}/test': {
        post: {
          tags: ['channels'],
          summary: 'Send a test notification',
          description:
            'Reports the delivery outcome. The error string never includes the destination secret.',
          parameters: [pathParameter('id', 'Channel id.')],
          requestBody: jsonBody(
            '#/components/schemas/ChannelTestRequest',
            'Optional custom message.',
          ),
          responses: {
            200: jsonResponse(
              {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  status: { type: ['integer', 'null'] },
                  error: { type: ['string', 'null'] },
                  durationMs: { type: 'integer' },
                },
              },
              'Delivery result.',
            ),
            404: errorResponses[404],
            ...authErrorResponses,
          },
        },
      },
      '/api/v1/system/info': {
        get: {
          tags: ['system'],
          summary: 'Read-only system information',
          responses: {
            200: jsonResponse(
              '#/components/schemas/SystemInfo',
              'Version, database, storage and capture configuration.',
            ),
            ...authErrorResponses,
          },
        },
      },
      '/healthz': {
        get: {
          tags: ['system'],
          summary: 'Liveness probe',
          description:
            'Answers from the process alone: a database outage does not make a healthy container look dead. Also served at `/api/v1/healthz`.',
          responses: { 200: jsonResponse('#/components/schemas/HealthResponse', 'Alive.') },
          security: [],
        },
      },
      '/readyz': {
        get: {
          tags: ['system'],
          summary: 'Readiness probe',
          description:
            'Checks the database, writes and deletes a probe file in the storage backend, and verifies Chromium can launch. In `api` mode the browser check is reported as skipped rather than failing. Also served at `/api/v1/readyz`.',
          responses: {
            200: jsonResponse('#/components/schemas/ReadyResponse', 'Ready.'),
            503: jsonResponse(
              '#/components/schemas/ReadyResponse',
              'Not ready; `checks` says which dependency failed.',
            ),
          },
          security: [],
        },
      },
      '/metrics': {
        get: {
          tags: ['system'],
          summary: 'Prometheus metrics',
          description:
            'Exposes `pagefreeze_captures_total{status}`, `pagefreeze_capture_duration_seconds`, `pagefreeze_changes_total{significant}`, `pagefreeze_queue_depth{queue}`, `pagefreeze_captures_in_flight`, `pagefreeze_monitors_total`, `pagefreeze_snapshots_total`, `pagefreeze_storage_bytes` and `pagefreeze_process_uptime_seconds`. Also served at `/api/v1/metrics`.',
          responses: {
            200: {
              description: 'Prometheus text exposition format.',
              content: { 'text/plain': { schema: { type: 'string' } } },
            },
          },
          security: [],
        },
      },
    },
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'pagefreeze_session',
          description:
            'httpOnly, SameSite=Lax, Secure when PAGEFREEZE_SECURE_COOKIES is set. Mutating requests must also send the X-CSRF-Token header.',
        },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'API token created through POST /api/v1/tokens. Shown once, stored hashed.',
        },
      },
      schemas: {
        ...responseSchemas,
        Error: fromZod(errorResponseSchema, { io: 'output' }),
        LoginRequest: fromZod(loginSchema),
        MonitorCreateRequest: fromZod(monitorCreateSchema(0)),
        MonitorUpdateRequest: fromZod(monitorUpdateSchema(0)),
        ApiTokenCreateRequest: fromZod(apiTokenCreateSchema),
        ChannelCreateRequest: fromZod(channelCreateSchema),
        ChannelUpdateRequest: fromZod(channelUpdateSchema),
        ChannelTestRequest: fromZod(channelTestSchema),
        ShareCreateRequest: fromZod(shareCreateSchema),
        ShareView: {
          type: 'object',
          properties: {
            change: { $ref: '#/components/schemas/Change' },
            monitor: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                name: { type: ['string', 'null'] },
                url: { type: ['string', 'null'] },
              },
            },
            expiresAt: { type: ['string', 'null'], format: 'date-time' },
            urls: {
              type: 'object',
              properties: {
                before: { type: 'string' },
                after: { type: 'string' },
                diff: { type: ['string', 'null'] },
                textBefore: { type: 'string' },
                textAfter: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}

export function generateOpenApiYaml(): string {
  const header = [
    '# Generated by `pnpm openapi` from the zod schemas in packages/shared.',
    '# Do not edit by hand: run the generator and commit the result.',
    '',
  ].join('\n');
  return `${header}${toYaml(buildOpenApiDocument())}`;
}

export function openApiOutputPath(): string {
  return resolve(process.cwd(), '../../api/openapi.yaml');
}

export function writeOpenApi(target?: string): string {
  const path = target ?? openApiOutputPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, generateOpenApiYaml(), 'utf8');
  return path;
}

const invokedDirectly =
  process.argv[1]?.endsWith('generateOpenApi.ts') ||
  process.argv[1]?.endsWith('generateOpenApi.js');

if (invokedDirectly) {
  const target = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const path = writeOpenApi(target);
  process.stdout.write(`wrote ${path}\n`);
}
