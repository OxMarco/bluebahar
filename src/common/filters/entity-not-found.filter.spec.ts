import type { ArgumentsHost } from '@nestjs/common';
import { EntityNotFoundError } from 'typeorm';
import { TypeOrmNotFoundExceptionFilter } from './entity-not-found.filter';

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

describe('TypeOrmNotFoundExceptionFilter', () => {
  it('returns a 404 envelope with the entity name extracted from the TypeORM message', () => {
    const { host, status, json } = buildHost({ originalUrl: '/v1/notices/42' });
    class Widget {}
    const error = new EntityNotFoundError(Widget, { id: 42 });

    new TypeOrmNotFoundExceptionFilter().catch(error, host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        code: 'ENTITY_NOT_FOUND',
        message: 'Widget not found',
        path: '/v1/notices/42',
      }),
    );
    const body = json.mock.calls[0]?.[0] as { timestamp?: unknown };
    expect(body.timestamp).toEqual(expect.any(String));
  });

  it('falls back to "Entity" when the TypeORM message does not include a type', () => {
    const { host, json } = buildHost({ originalUrl: '/v1/anything' });
    const error = Object.assign(new Error('something went wrong'), {
      name: 'EntityNotFoundError',
    }) as EntityNotFoundError;

    new TypeOrmNotFoundExceptionFilter().catch(error, host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Entity not found' }),
    );
  });

  it('falls back to request.url when originalUrl is missing', () => {
    const { host, json } = buildHost({ url: '/raw' });
    class Widget {}
    const error = new EntityNotFoundError(Widget, { id: 1 });

    new TypeOrmNotFoundExceptionFilter().catch(error, host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/raw' }),
    );
  });
});
