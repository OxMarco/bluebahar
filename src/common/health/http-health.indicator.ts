import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { fetchResponse } from '../utils/http';
import { errorMessage } from '../utils/error-message';

@Injectable()
export class HttpHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async pingCheck(key: string, url: string): Promise<HealthIndicatorResult> {
    const session = this.healthIndicatorService.check(key);
    try {
      const response = await fetchResponse(url);
      if (response.status >= 500) {
        return session.down({
          statusCode: response.status,
          message: `HTTP ${response.status} ${response.statusText}`.trim(),
        });
      }
      return session.up({ statusCode: response.status });
    } catch (err) {
      return session.down({ message: errorMessage(err) });
    }
  }
}
