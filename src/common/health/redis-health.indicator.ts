import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import type { createClient } from '@keyv/redis';
import { errorMessage } from '../utils/error-message';

export const REDIS_HEALTH_CLIENT = Symbol('REDIS_HEALTH_CLIENT');
export type RedisHealthClient = ReturnType<typeof createClient>;

@Injectable()
export class RedisHealthIndicator implements OnApplicationShutdown {
  private readonly client: ReturnType<typeof createClient>;

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    @Inject(REDIS_HEALTH_CLIENT) client: RedisHealthClient,
  ) {
    this.client = client;
  }

  async pingCheck(key: string): Promise<HealthIndicatorResult> {
    const session = this.healthIndicatorService.check(key);
    try {
      if (!this.client.isOpen) await this.client.connect();
      const reply = await this.client.ping();
      return reply === 'PONG'
        ? session.up()
        : session.down({ message: `Unexpected PING reply: ${reply}` });
    } catch (err) {
      return session.down({ message: errorMessage(err) });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client.isOpen) await this.client.close();
  }
}
