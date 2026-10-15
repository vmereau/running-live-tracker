// Fastify app factory: routes and error mapping, no listening. main.ts owns the port.
import { statSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { ErrorBody } from '@running-live-tracker/shared';
import type { EventConfig } from '../config/load-config.ts';
import { createLiveHub } from '../live/sse-hub.ts';
import { buildSnapshot } from '../projection/snapshot.ts';

export type HealthResponse = { ok: true; serverNow: number; eventId: string };

export type BuildAppOptions = {
  config: EventConfig;
  /** Server clock, epoch ms. Injected so tests are deterministic. */
  now: () => number;
  logger?: FastifyServerOptions['logger'];
  /** SSE heartbeat interval; 20 s by default (AD-6). Injected so tests are fast. */
  pingIntervalMs?: number;
  /** Built web app (web/dist). Served at / when the directory exists. */
  webRoot?: string;
};

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

const CLIENT_ERROR_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

function statusOf(error: unknown): number {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? status : 500;
}

export function buildApp({ config, now, logger = false, pingIntervalMs, webRoot }: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger });
  const getSnapshot = () => buildSnapshot(config, now());
  const hub = createLiveHub({ getSnapshot, pingIntervalMs });
  // Hijacked SSE responses are invisible to Fastify; end them or close() would wait forever.
  app.addHook('preClose', async () => hub.closeAll());

  app.get('/api/v1/health', async (): Promise<HealthResponse> => ({
    ok: true,
    serverNow: now(),
    eventId: config.eventId,
  }));

  app.get('/api/v1/snapshot', async () => getSnapshot());

  // AD-6: hijacked reply, so no Fastify hook (compression, onSend) touches the stream.
  // No auto HEAD route: a hijacked HEAD response would never flush and would hold a hub slot.
  app.get('/api/v1/live', { exposeHeadRoute: false }, (_request, reply) => {
    reply.hijack();
    hub.attach(reply.raw);
  });

  if (webRoot !== undefined) {
    if (isDirectory(webRoot)) {
      // Misses fall through to the not-found handler below (JSON 404 ErrorBody).
      void app.register(fastifyStatic, { root: webRoot, prefix: '/' });
    } else {
      app.log.warn({ webRoot }, 'web build not found, not serving the web app (run pnpm --filter web build)');
    }
  }

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send(errorBody('NOT_FOUND', `Route ${request.method} ${request.url} not found`));
  });

  app.setErrorHandler(async (error, request, reply) => {
    const status = statusOf(error);
    if (status >= 400 && status < 500) {
      const message = error instanceof Error ? error.message : 'Bad request';
      return reply.code(status).send(errorBody(CLIENT_ERROR_CODES[status] ?? 'BAD_REQUEST', message));
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send(errorBody('INTERNAL_ERROR', 'Internal server error'));
  });

  return app;
}
