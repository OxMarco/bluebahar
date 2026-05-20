import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

export const ADMIN_API_KEY_HEADER = 'x-admin-api-key';

// Guards every /admin route with a shared secret supplied via the
// X-Admin-Api-Key header. The key is compared in constant time so a wrong
// guess can't be narrowed down by response timing.
@Injectable()
export class AdminApiKeyGuard implements CanActivate {
  private readonly apiKey: Buffer;

  constructor(configService: ConfigService) {
    this.apiKey = Buffer.from(
      configService.getOrThrow<string>('ADMIN_API_KEY'),
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = this.extractKey(request);
    if (provided === undefined || !this.matches(provided)) {
      throw new UnauthorizedException();
    }
    return true;
  }

  private extractKey(request: Request): string | undefined {
    const header = request.headers[ADMIN_API_KEY_HEADER];
    if (typeof header === 'string') return header;
    if (Array.isArray(header)) return header[0];
    return undefined;
  }

  private matches(provided: string): boolean {
    const providedBuf = Buffer.from(provided);
    // timingSafeEqual throws on length mismatch, so guard it first. The length
    // check leaks only the key length, not its contents.
    if (providedBuf.length !== this.apiKey.length) return false;
    return timingSafeEqual(providedBuf, this.apiKey);
  }
}
