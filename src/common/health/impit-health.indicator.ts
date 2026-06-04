import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { proxiedImpit } from '../utils/http';

@Injectable()
export class ImpitHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async pingCheck(key: string, url: string): Promise<HealthIndicatorResult> {
    const session = this.healthIndicatorService.check(key);
    try {
      const res = await proxiedImpit.fetch(url);
      if (res.status >= 500) {
        return session.down({
          statusCode: res.status,
          message: `HTTP ${res.status} ${res.statusText}`.trim(),
        });
      }
      return session.up({ statusCode: res.status });
    } catch (err) {
      return session.down({
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
