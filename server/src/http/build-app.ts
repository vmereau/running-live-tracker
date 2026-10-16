// Fastify app factory: routes and error mapping, no listening. main.ts owns the port.
import { statSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyRequest, FastifyServerOptions } from 'fastify';
import type { ErrorBody } from '@running-live-tracker/shared';
import type { EventConfig } from '../config/load-config.ts';
import type { Ingest } from '../ingest/ingest.ts';
import { createLiveHub } from '../live/sse-hub.ts';
import { buildSnapshot } from '../projection/snapshot.ts';

export type HealthResponse = { ok: true; serverNow: number; eventId: string };

export type BuildAppOptions = {
  config: EventConfig;
  /** Ingest service (built by main.ts around the store, since http may not import store). */
  ingest: Ingest;
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

export function buildApp({ config, ingest, now, logger = false, pingIntervalMs, webRoot }: BuildAppOptions): FastifyInstance {
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

  // AD-3/AD-5: auth runs in onRequest, before the body is read, so a request without a
  // valid key always gets 401 and its body is never parsed. Logs never carry the key,
  // the Authorization header or the body.
  const ingestRunner = new WeakMap<FastifyRequest, string>();
  app.post(
    '/api/v1/ingest',
    {
      onRequest: async (request, reply) => {
        const runnerId = ingest.authenticate(request.headers.authorization);
        if (runnerId === undefined) {
          request.log.warn({ code: 'UNAUTHORIZED' }, 'ingest rejected');
          return reply.code(401).send(errorBody('UNAUTHORIZED', 'Missing or invalid runner key'));
        }
        ingestRunner.set(request, runnerId);
      },
      // Body parsing failures (malformed JSON, wrong content type, over the byte limit)
      // use the ingest error codes instead of the generic ones.
      errorHandler: async (error, request, reply) => {
        const status = statusOf(error);
        if (status >= 500 || status < 400) throw error;
        // Fixed messages: parser errors (e.g. V8's SyntaxError) quote parts of the body.
        const [code, httpStatus, message] =
          status === 413 ? ['BATCH_TOO_LARGE', 413, 'Body too large'] : ['INVALID_BATCH', 400, 'Body is not valid JSON'];
        request.log.warn({ runnerId: ingestRunner.get(request), code }, 'ingest rejected');
        return reply.code(httpStatus).send(errorBody(code, message));
      },
    },
    async (request, reply) => {
      const runnerId = ingestRunner.get(request)!;
      const result = ingest.ingestBatch(runnerId, request.body);
      if (!result.ok) {
        request.log.warn({ runnerId, code: result.code }, 'ingest rejected');
        return reply.code(result.status).send(errorBody(result.code, result.message));
      }
      const { ack, recordCount, inserted, clockSkewMs } = result;
      request.log.info(
        { runnerId, sessionId: ack.sessionId, recordCount, inserted, ackedThroughSeq: ack.ackedThroughSeq, clockSkewMs },
        'ingest batch accepted',
      );
      return ack;
    },
  );

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
