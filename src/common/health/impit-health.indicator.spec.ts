import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { proxiedImpit } from '../utils/http';
import { ImpitHealthIndicator } from './impit-health.indicator';

jest.mock('../utils/http', () => ({
  proxiedImpit: { fetch: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/unbound-method -- proxiedImpit.fetch is a jest mock with no `this` dependency.
const fetchMock = jest.mocked(proxiedImpit).fetch;

type SessionMock = {
  up: jest.Mock<HealthIndicatorResult, [Record<string, unknown>?]>;
  down: jest.Mock<HealthIndicatorResult, [Record<string, unknown>?]>;
};

function buildIndicator() {
  const session: SessionMock = {
    up: jest
      .fn<HealthIndicatorResult, [Record<string, unknown>?]>()
      .mockImplementation((meta) => ({
        target: { status: 'up', ...(meta ?? {}) },
      })),
    down: jest
      .fn<HealthIndicatorResult, [Record<string, unknown>?]>()
      .mockImplementation((meta) => ({
        target: { status: 'down', ...(meta ?? {}) },
      })),
  };
  const healthIndicatorService = {
    check: jest.fn().mockReturnValue(session),
  } as unknown as HealthIndicatorService;
  return {
    indicator: new ImpitHealthIndicator(healthIndicatorService),
    session,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('ImpitHealthIndicator', () => {
  it('reports up for any non-5xx response', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      statusText: 'OK',
    } as unknown as Awaited<ReturnType<typeof proxiedImpit.fetch>>);
    const { indicator, session } = buildIndicator();

    await expect(
      indicator.pingCheck('target', 'https://example.com'),
    ).resolves.toEqual({ target: { status: 'up', statusCode: 200 } });
    expect(session.up).toHaveBeenCalledWith({ statusCode: 200 });
    expect(session.down).not.toHaveBeenCalled();
  });

  it('still reports up for 4xx responses since the host is reachable', async () => {
    fetchMock.mockResolvedValue({
      status: 404,
      statusText: 'Not Found',
    } as unknown as Awaited<ReturnType<typeof proxiedImpit.fetch>>);
    const { indicator, session } = buildIndicator();

    await indicator.pingCheck('target', 'https://example.com');

    expect(session.up).toHaveBeenCalledWith({ statusCode: 404 });
    expect(session.down).not.toHaveBeenCalled();
  });

  it('reports down with HTTP context on 5xx responses', async () => {
    fetchMock.mockResolvedValue({
      status: 503,
      statusText: 'Service Unavailable',
    } as unknown as Awaited<ReturnType<typeof proxiedImpit.fetch>>);
    const { indicator, session } = buildIndicator();

    await expect(
      indicator.pingCheck('target', 'https://example.com'),
    ).resolves.toEqual({
      target: {
        status: 'down',
        statusCode: 503,
        message: 'HTTP 503 Service Unavailable',
      },
    });
    expect(session.down).toHaveBeenCalledTimes(1);
  });

  it('reports down with the thrown error message when the fetch rejects', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const { indicator, session } = buildIndicator();

    await expect(
      indicator.pingCheck('target', 'https://example.com'),
    ).resolves.toEqual({ target: { status: 'down', message: 'ECONNRESET' } });
    expect(session.down).toHaveBeenCalledWith({ message: 'ECONNRESET' });
  });

  it('stringifies non-Error rejections', async () => {
    fetchMock.mockRejectedValue('boom');
    const { indicator, session } = buildIndicator();

    await indicator.pingCheck('target', 'https://example.com');

    expect(session.down).toHaveBeenCalledWith({ message: 'boom' });
  });
});
