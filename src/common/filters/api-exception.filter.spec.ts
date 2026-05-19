import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiExceptionFilter } from './api-exception.filter';

function buildHost(req: { originalUrl?: string; url?: string }) {
  const json = jest.fn<void, [unknown]>();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ status }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('ApiExceptionFilter', () => {
  it('serializes HttpExceptions with stable error metadata', () => {
    const { host, status, json } = buildHost({ originalUrl: '/v1/missing' });

    new ApiExceptionFilter().catch(new NotFoundException('Nope'), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Nope',
        path: '/v1/missing',
      }),
    );
    const body = json.mock.calls[0]?.[0] as { timestamp?: unknown };
    expect(body.timestamp).toEqual(expect.any(String));
  });

  it('promotes an array message to details (ValidationPipe shape)', () => {
    const { host, json } = buildHost({ originalUrl: '/v1/notices' });
    const exception = new UnprocessableEntityException([
      'limit must be a number',
      'kind must be in the allowed set',
    ]);

    new ApiExceptionFilter().catch(exception, host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 422,
        code: 'UNPROCESSABLE_ENTITY',
        message: ['limit must be a number', 'kind must be in the allowed set'],
        details: ['limit must be a number', 'kind must be in the allowed set'],
      }),
    );
  });

  it('uses the response.error name to derive the code when no explicit code is present', () => {
    const { host, json } = buildHost({ originalUrl: '/v1/oops' });
    const exception = new HttpException({ error: 'I Am A Teapot' }, 418);

    new ApiExceptionFilter().catch(exception, host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 418,
        code: 'I_AM_A_TEAPOT',
        message: 'I Am A Teapot',
      }),
    );
  });

  it('honors an explicit code on the response body over the status fallback', () => {
    const { host, json } = buildHost({ originalUrl: '/v1/oops' });
    const exception = new BadRequestException({
      code: 'CUSTOM_DOMAIN_ERROR',
      message: 'something broke',
      details: { hint: 'fix it' },
    });

    new ApiExceptionFilter().catch(exception, host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        code: 'CUSTOM_DOMAIN_ERROR',
        message: 'something broke',
        details: { hint: 'fix it' },
      }),
    );
  });

  it('falls back to a generic message when neither message nor error is set on the body', () => {
    const { host, json } = buildHost({ originalUrl: '/v1/oops' });
    const exception = new HttpException({}, 400);

    new ApiExceptionFilter().catch(exception, host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        code: 'BAD_REQUEST',
        message: 'The request could not be processed.',
      }),
    );
  });

  it('synthesizes a code for status codes not in the lookup table', () => {
    const { host, json } = buildHost({ originalUrl: '/v1/oops' });
    // 451 is a real status (Unavailable for Legal Reasons) not in the names map.
    const exception = new HttpException('blocked', 451);

    new ApiExceptionFilter().catch(exception, host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 451,
        code: 'HTTP_451',
        message: 'blocked',
      }),
    );
  });

  it('maps 500 InternalServerErrorException to INTERNAL_SERVER_ERROR', () => {
    const { host, json } = buildHost({ originalUrl: '/v1/oops' });

    new ApiExceptionFilter().catch(new InternalServerErrorException(), host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        code: 'INTERNAL_SERVER_ERROR',
      }),
    );
  });

  it('falls back to request.url when originalUrl is missing', () => {
    const { host, json } = buildHost({ url: '/raw' });

    new ApiExceptionFilter().catch(new NotFoundException('Nope'), host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/raw' }),
    );
  });
});
