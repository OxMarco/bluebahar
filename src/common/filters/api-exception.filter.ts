import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface ErrorBody {
  code?: string;
  error?: string;
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
    record.message ?? record.error ?? 'The request could not be processed.';
  return {
    ...record,
    message,
    details:
      record.details ??
      (Array.isArray(record.message) ? record.message : undefined),
  };
}

function codeFromStatus(statusCode: number, fallback?: string): string {
  if (fallback) return slugCode(fallback);
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
