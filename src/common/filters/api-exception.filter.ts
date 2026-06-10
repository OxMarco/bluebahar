import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as Sentry from '@sentry/nestjs';

interface ErrorBody {
  code?: string;
  // `error` is usually the HTTP status text, but e.g. Terminus health-check
  // failures put an OBJECT here ({ database: { status: 'down' } }) — never
  // assume string.
  error?: unknown;
  message?: string | string[];
  details?: unknown;
}

@Catch(HttpException)
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();
    const statusCode = exception.getStatus();
    const body = normalizeBody(exception.getResponse());

    // This filter handles every HttpException before the SentryGlobalFilter
    // gets a chance to (Nest dispatches the LAST registered matching filter
    // first), so deliberate 5xx responses must be reported here or they'd
    // never reach Sentry.
    if (statusCode >= 500) {
      Sentry.captureException(exception);
    }

    response.status(statusCode).json({
      statusCode,
      code: body.code ?? codeFromStatus(statusCode, body.error),
      message: body.message,
      ...(body.details !== undefined ? { details: body.details } : {}),
      path: request.originalUrl ?? request.url,
      timestamp: new Date().toISOString(),
    });
  }
}

function normalizeBody(
  body: string | object,
): Required<Pick<ErrorBody, 'message'>> & Omit<ErrorBody, 'message'> {
  if (typeof body === 'string') {
    return { message: body };
  }
  const record = body as ErrorBody;
  const message =
    record.message ??
    (typeof record.error === 'string'
      ? record.error
      : 'The request could not be processed.');
  return {
    ...record,
    message,
    details:
      record.details ??
      (Array.isArray(record.message) ? record.message : undefined),
  };
}

function codeFromStatus(statusCode: number, fallback?: unknown): string {
  if (typeof fallback === 'string' && fallback) return slugCode(fallback);
  const names: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    422: 'UNPROCESSABLE_ENTITY',
    429: 'TOO_MANY_REQUESTS',
    500: 'INTERNAL_SERVER_ERROR',
    503: 'SERVICE_UNAVAILABLE',
  };
  return names[statusCode] ?? `HTTP_${statusCode}`;
}

function slugCode(value: string): string {
  return value
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}
