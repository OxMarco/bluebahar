import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { Queue } from 'bullmq';
import { errorMessage } from '../utils/error-message';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    // Reuses the BullMQ connection rather than opening a second Redis socket.
    @InjectQueue('scraper')
    private readonly queue: Queue,
  ) {}

  async pingCheck(key: string): Promise<HealthIndicatorResult> {
    const session = this.healthIndicatorService.check(key);
    try {
      const client = await this.queue.client;
      const reply: string = await client.ping();
      return reply === 'PONG'
        ? session.up()
        : session.down({ message: `Unexpected PING reply: ${reply}` });
    } catch (err) {
      return session.down({ message: errorMessage(err) });
    }
  }
}
