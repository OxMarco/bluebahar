import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AdminApiKeyGuard, ADMIN_API_KEY_HEADER } from './admin-api-key.guard';

const API_KEY = 'a'.repeat(32);

function makeContext(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

describe('AdminApiKeyGuard', () => {
  let guard: AdminApiKeyGuard;

  beforeEach(() => {
    const configService = {
      getOrThrow: jest.fn().mockReturnValue(API_KEY),
    } as unknown as ConfigService;
    guard = new AdminApiKeyGuard(configService);
  });

  it('allows requests with the correct key', () => {
    expect(
      guard.canActivate(makeContext({ [ADMIN_API_KEY_HEADER]: API_KEY })),
    ).toBe(true);
  });

  it('rejects a missing key', () => {
    expect(() => guard.canActivate(makeContext({}))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a wrong key of the same length', () => {
    expect(() =>
      guard.canActivate(
        makeContext({ [ADMIN_API_KEY_HEADER]: 'b'.repeat(32) }),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a key of a different length', () => {
    expect(() =>
      guard.canActivate(makeContext({ [ADMIN_API_KEY_HEADER]: 'short' })),
    ).toThrow(UnauthorizedException);
  });
});
