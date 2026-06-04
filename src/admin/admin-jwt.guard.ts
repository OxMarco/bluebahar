import {
  ArgumentsHost,
  CanActivate,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';

export const ADMIN_SESSION_COOKIE = 'admin_session';

// Thrown by AdminJwtGuard when an unauthenticated full-page navigation should
// be bounced to the login page. A guard must not write to the response itself:
// calling response.redirect() and then returning false makes Nest reject the
// request and try to send a *second* response, which throws "Cannot set headers
// after they are sent to the client". Throwing instead lets the filter below own
// the single response write. `expired` is true when a session token was present
// but failed verification, so the login page can surface a "session expired"
// notice rather than greeting a fresh visitor with it.
export class AdminLoginRedirect extends UnauthorizedException {
  constructor(readonly expired = false) {
    super();
  }
}

@Catch(AdminLoginRedirect)
export class AdminLoginRedirectFilter implements ExceptionFilter {
  catch(exception: AdminLoginRedirect, host: ArgumentsHost) {
    const target = exception.expired
      ? '/admin/login?expired=1'
      : '/admin/login';
    host.switchToHttp().getResponse<Response>().redirect(target);
  }
}

// Guards the browser-facing /admin view routes. The session JWT lives in an
// httpOnly cookie (set by AdminViewController.login). Failed checks redirect
// full-page navigations to /admin/login but throw 401 for HTMX requests, so
// the panel surfaces session expiry without a confusing partial-page redirect.
@Injectable()
export class AdminJwtGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();

    const token = (request.cookies ?? {})[ADMIN_SESSION_COOKIE] as
      | string
      | undefined;
    let expired = false;
    if (token) {
      try {
        this.jwtService.verify(token);
        return true;
      } catch {
        // A token was present but is invalid/expired — fall through and tell
        // the login page so, so the user gets a "session expired" notice.
        expired = true;
      }
    }

    // HTMX sets HX-Request: true on its fetches. For those we want a real
    // 401 (HTMX can read the status and reload), not a redirect that swaps
    // an entire login page into a table cell.
    if (request.header('HX-Request')) {
      throw new UnauthorizedException();
    }
    throw new AdminLoginRedirect(expired);
  }
}
