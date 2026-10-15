// Fastify app factory: routes and error mapping, no listening. main.ts owns the port.
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { ErrorBody } from '@running-live-tracker/shared';
import type { EventConfig } from '../config/load-config.ts';

export type HealthResponse = { ok: true; serverNow: number; eventId: string };

export type BuildAppOptions = {
  config: EventConfig;
  /** Server clock, epoch ms. Injected so tests are deterministic. */
  now: () => number;
  logger?: FastifyServerOptions['logger'];
};

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

export function buildApp({ config, now, logger = false }: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger });

  app.get('/api/v1/health', async (): Promise<HealthResponse> => ({
    ok: true,
    serverNow: now(),
    eventId: config.eventId,
  }));

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
