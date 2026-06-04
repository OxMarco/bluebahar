import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  AdminJwtGuard,
  AdminLoginRedirect,
  AdminLoginRedirectFilter,
  ADMIN_SESSION_COOKIE,
} from './admin-jwt.guard';

function context(
  request: Record<string, unknown>,
  response: Record<string, unknown> = {},
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function makeRequest(
  cookieToken?: string,
  headers: Record<string, string> = {},
): Record<string, unknown> {
  return {
    cookies: cookieToken ? { [ADMIN_SESSION_COOKIE]: cookieToken } : {},
    header: (name: string) => headers[name],
  };
}

describe('AdminJwtGuard', () => {
  let jwt: { verify: jest.Mock };
  let guard: AdminJwtGuard;

  beforeEach(() => {
    jwt = { verify: jest.fn() };
    guard = new AdminJwtGuard(jwt as unknown as JwtService);
  });

  it('allows requests with a valid session token', () => {
    jwt.verify.mockReturnValue({ sub: 'admin' });
    expect(guard.canActivate(context(makeRequest('good-token')))).toBe(true);
    expect(jwt.verify).toHaveBeenCalledWith('good-token');
  });

  it('throws a non-expired AdminLoginRedirect when no token is present', () => {
    try {
      guard.canActivate(context(makeRequest()));
      fail('expected AdminLoginRedirect');
    } catch (err) {
      expect(err).toBeInstanceOf(AdminLoginRedirect);
      expect((err as AdminLoginRedirect).expired).toBe(false);
    }
  });

  it('throws an expired AdminLoginRedirect when the token is invalid', () => {
    jwt.verify.mockImplementation(() => {
      throw new Error('expired');
    });
    try {
      guard.canActivate(context(makeRequest('stale')));
      fail('expected AdminLoginRedirect');
    } catch (err) {
      expect(err).toBeInstanceOf(AdminLoginRedirect);
      expect((err as AdminLoginRedirect).expired).toBe(true);
    }
  });

  it('throws a plain 401 for HTMX requests so they can reload', () => {
    const run = () =>
      guard.canActivate(
        context(makeRequest(undefined, { 'HX-Request': 'true' })),
      );
    expect(run).toThrow(UnauthorizedException);
    expect(run).not.toThrow(AdminLoginRedirect);
  });

  // Regression: the guard must never write to the response itself. Doing so and
  // then rejecting the request made Nest send a second response, throwing
  // "Cannot set headers after they are sent to the client".
  it('does not touch the response object', () => {
    const redirect = jest.fn();
    expect(() =>
      guard.canActivate(context(makeRequest(), { redirect })),
    ).toThrow(AdminLoginRedirect);
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe('AdminLoginRedirectFilter', () => {
  function hostWith(redirect: jest.Mock) {
    return {
      switchToHttp: () => ({ getResponse: () => ({ redirect }) }),
    } as unknown as Parameters<AdminLoginRedirectFilter['catch']>[1];
  }

  it('redirects to the login page for a fresh visitor', () => {
    const redirect = jest.fn();
    new AdminLoginRedirectFilter().catch(
      new AdminLoginRedirect(),
      hostWith(redirect),
    );
    expect(redirect).toHaveBeenCalledWith('/admin/login');
  });

  it('flags an expired session in the redirect so the notice shows', () => {
    const redirect = jest.fn();
    new AdminLoginRedirectFilter().catch(
      new AdminLoginRedirect(true),
      hostWith(redirect),
    );
    expect(redirect).toHaveBeenCalledWith('/admin/login?expired=1');
  });
});
