import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';

export const ADMIN_SESSION_COOKIE = 'admin_session';

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
    const response = http.getResponse<Response>();

    const token = (request.cookies ?? {})[ADMIN_SESSION_COOKIE] as
      | string
      | undefined;
    if (token) {
      try {
        this.jwtService.verify(token);
        return true;
      } catch {
        // fall through to unauthenticated handling
      }
    }

    // HTMX sets HX-Request: true on its fetches. For those we want a real
    // 401 (HTMX can read the status and reload), not a redirect that swaps
    // an entire login page into a table cell.
    if (request.header('HX-Request')) {
      throw new UnauthorizedException();
    }
    response.redirect('/admin/login');
    return false;
  }
}
