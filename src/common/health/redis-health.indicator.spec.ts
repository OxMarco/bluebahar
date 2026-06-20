import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import {
  RedisHealthIndicator,
  type RedisHealthClient,
} from './redis-health.indicator';

type SessionMock = {
  up: jest.Mock<HealthIndicatorResult, [Record<string, unknown>?]>;
  down: jest.Mock<HealthIndicatorResult, [Record<string, unknown>?]>;
};

function buildIndicator(opts: {
  ping: jest.Mock<Promise<string>, []>;
  connectRejects?: Error;
}) {
  const session: SessionMock = {
    up: jest
      .fn<HealthIndicatorResult, [Record<string, unknown>?]>()
      .mockImplementation((meta) => ({
        redis: { status: 'up', ...(meta ?? {}) },
      })),
    down: jest
      .fn<HealthIndicatorResult, [Record<string, unknown>?]>()
      .mockImplementation((meta) => ({
        redis: { status: 'down', ...(meta ?? {}) },
      })),
  };
  const healthIndicatorService = {
    check: jest.fn().mockReturnValue(session),
  } as unknown as HealthIndicatorService;

  const client = {
    isOpen: false,
    connect: opts.connectRejects
      ? jest.fn().mockRejectedValue(opts.connectRejects)
      : jest.fn().mockImplementation(function (this: { isOpen: boolean }) {
          this.isOpen = true;
          return Promise.resolve();
        }),
    ping: opts.ping,
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as RedisHealthClient;

  return {
    indicator: new RedisHealthIndicator(healthIndicatorService, client),
    session,
  };
}

describe('RedisHealthIndicator', () => {
  it('reports up when Redis replies PONG', async () => {
    const { indicator, session } = buildIndicator({
      ping: jest.fn<Promise<string>, []>().mockResolvedValue('PONG'),
    });

    await expect(indicator.pingCheck('redis')).resolves.toEqual({
      redis: { status: 'up' },
    });
    expect(session.up).toHaveBeenCalledTimes(1);
    expect(session.down).not.toHaveBeenCalled();
  });

  it('reports down when Redis replies with anything other than PONG', async () => {
    const { indicator, session } = buildIndicator({
      ping: jest.fn<Promise<string>, []>().mockResolvedValue('NOPE'),
    });

    await expect(indicator.pingCheck('redis')).resolves.toEqual({
      redis: { status: 'down', message: 'Unexpected PING reply: NOPE' },
    });
    expect(session.down).toHaveBeenCalledTimes(1);
  });

  it('reports down when the client connection rejects', async () => {
    const { indicator, session } = buildIndicator({
      ping: jest.fn<Promise<string>, []>(),
      connectRejects: new Error('ECONNREFUSED'),
    });

    await expect(indicator.pingCheck('redis')).resolves.toEqual({
      redis: { status: 'down', message: 'ECONNREFUSED' },
    });
    expect(session.down).toHaveBeenCalledWith({ message: 'ECONNREFUSED' });
  });
});
