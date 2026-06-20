import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { fetchResponse } from '../utils/http';
import { HttpHealthIndicator } from './http-health.indicator';

jest.mock('../utils/http', () => ({ fetchResponse: jest.fn() }));

const fetchMock = jest.mocked(fetchResponse);

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
    indicator: new HttpHealthIndicator(healthIndicatorService),
    session,
  };
}

beforeEach(() => fetchMock.mockReset());

describe('HttpHealthIndicator', () => {
  it('reports reachable non-5xx responses as up', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    const { indicator, session } = buildIndicator();

    await indicator.pingCheck('target', 'https://example.com');

    expect(session.up).toHaveBeenCalledWith({ statusCode: 404 });
  });

  it('reports 5xx responses as down', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 503, statusText: 'Service Unavailable' }),
    );
    const { indicator, session } = buildIndicator();

    await indicator.pingCheck('target', 'https://example.com');

    expect(session.down).toHaveBeenCalledWith({
      statusCode: 503,
      message: 'HTTP 503 Service Unavailable',
    });
  });

  it('reports transport failures as down', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const { indicator, session } = buildIndicator();

    await indicator.pingCheck('target', 'https://example.com');

    expect(session.down).toHaveBeenCalledWith({ message: 'ECONNRESET' });
  });
});
