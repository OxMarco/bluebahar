import { ArgumentsHost, NotFoundException } from '@nestjs/common';
import { ApiExceptionFilter } from './api-exception.filter';

describe('ApiExceptionFilter', () => {
  it('serializes HttpExceptions with stable error metadata', () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ originalUrl: '/v1/missing' }),
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost;

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
    expect(json.mock.calls[0]?.[0].timestamp).toEqual(expect.any(String));
  });
});
