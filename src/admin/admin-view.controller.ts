import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  ExceptionFilter,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Render,
  Res,
  UseFilters,
  UseGuards,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import * as Sentry from '@sentry/nestjs';
import { AdminService } from './admin.service';
import {
  AdminJwtGuard,
  AdminLoginRedirectFilter,
  ADMIN_SESSION_COOKIE,
} from './admin-jwt.guard';
import { LoginDto } from './dto/login.dto';
import { CreateNoticeDto } from './dto/create-notice.dto';
import { ViewLogsDto } from './dto/view-logs.dto';
import { ViewFlaggedDto } from './dto/view-flagged.dto';
import { GetNoticesDto } from '../map/dto/get-notices.dto';
import { Paginated } from '../common/dto/paginated.dto';
import { LogType } from '../scraper/log-type';
import { NoticeKind } from '../scraper/notice-kind';

@Catch()
class AdminCreateNoticeExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host
      .switchToHttp()
      .getRequest<{ body?: Record<string, unknown> }>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    if (!(exception instanceof HttpException) || status >= 500) {
      Sentry.captureException(exception, {
        tags: { area: 'admin', action: 'create-notice' },
      });
    }

    return response.status(status).render('admin/new', {
      page: 'new',
      title: 'Add notice',
      kinds: Object.values(NoticeKind),
      error: createNoticeErrorMessage(exception),
      success: null,
      form: request.body ?? {},
    });
  }
}

@Catch(HttpException)
class AdminLoginExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();

    return response.status(exception.getStatus()).render('admin/login', {
      error: 'Invalid key.',
      notice: null,
    });
  }
}

function createNoticeErrorMessage(exception: unknown): string {
  if (!(exception instanceof HttpException)) {
    return 'Unable to create notice. Please try again or check the server logs.';
  }

  const response = exception.getResponse();
  if (typeof response === 'object' && response !== null) {
    const message = (response as { message?: unknown }).message;
    if (Array.isArray(message)) {
      const visible = message.filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      );
      if (visible.length > 0) return visible.join(' ');
    }
    if (typeof message === 'string' && message.length > 0) return message;
  }

  const status: HttpStatus = exception.getStatus();
  if (status === HttpStatus.UNPROCESSABLE_ENTITY) {
    return 'Unable to create notice. Check required fields and date or number formats.';
  }

  return 'Unable to create notice. Please try again.';
}

// Browser-facing admin panel. Auth is a session JWT in an httpOnly cookie,
// minted by /admin/login after a constant-time check against ADMIN_API_KEY.
// All other routes are gated by AdminJwtGuard.
@Controller({ path: 'admin', version: VERSION_NEUTRAL })
@UseFilters(AdminLoginRedirectFilter)
export class AdminViewController {
  private readonly adminKey: Buffer;
  private readonly sessionTtlSeconds: number;

  constructor(
    private readonly adminService: AdminService,
    private readonly jwtService: JwtService,
    configService: ConfigService,
  ) {
    this.adminKey = Buffer.from(
      configService.getOrThrow<string>('ADMIN_API_KEY'),
    );
    this.sessionTtlSeconds = configService.getOrThrow<number>(
      'ADMIN_SESSION_TTL_SECONDS',
    );
  }

  @Get('login')
  @Render('admin/login')
  loginPage(@Query('expired') expired?: string) {
    return {
      error: null,
      notice:
        expired === '1' ? 'Your session expired. Please sign in again.' : null,
    };
  }

  @Post('login')
  @UseFilters(AdminLoginExceptionFilter)
  login(@Body() dto: LoginDto, @Res() res: Response) {
    if (!this.keyMatches(dto.key)) {
      // Re-render the login page with an inline error rather than 401-ing —
      // this is a human-facing form, not an API.
      return res.status(HttpStatus.UNAUTHORIZED).render('admin/login', {
        error: 'Invalid key.',
        notice: null,
      });
    }
    const token = this.jwtService.sign(
      { sub: 'admin' },
      { expiresIn: this.sessionTtlSeconds },
    );
    res.cookie(ADMIN_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: this.sessionTtlSeconds * 1000,
      path: '/admin',
    });
    return res.redirect('/admin/review');
  }

  @Post('logout')
  logout(@Res() res: Response) {
    res.clearCookie(ADMIN_SESSION_COOKIE, { path: '/admin' });
    return res.redirect('/admin/login');
  }

  @Get()
  @UseGuards(AdminJwtGuard)
  root(@Res() res: Response) {
    return res.redirect('/admin/review');
  }

  @Get('review')
  @UseGuards(AdminJwtGuard)
  @Render('admin/review')
  async reviewPage(@Query() query: GetNoticesDto) {
    const page = await this.adminService.viewNoticesInReview(query);
    return {
      page: 'review',
      title: 'Review queue',
      notices: page.items,
      pagination: paginationMeta(page, query),
    };
  }

  @Get('flagged')
  @UseGuards(AdminJwtGuard)
  @Render('admin/flagged')
  async flaggedPage(@Query() query: ViewFlaggedDto) {
    const page = await this.adminService.viewFlaggedNotices(query);
    return {
      page: 'flagged',
      title: 'User-flagged notices',
      notices: page.items,
      minReports: query.minReports,
      pagination: paginationMeta(page, query),
    };
  }

  @Get('logs')
  @UseGuards(AdminJwtGuard)
  @Render('admin/logs')
  async logsPage(@Query() query: ViewLogsDto) {
    const page = await this.adminService.viewLogs(query);
    return {
      page: 'logs',
      title: 'Logs',
      logs: page.items,
      logTypes: Object.values(LogType),
      selectedLogType: query.logType ?? '',
      pagination: paginationMeta(page, query),
    };
  }

  @Get('new')
  @UseGuards(AdminJwtGuard)
  @Render('admin/new')
  newPage() {
    return {
      page: 'new',
      title: 'Add notice',
      kinds: Object.values(NoticeKind),
      error: null,
      success: null,
      form: {},
    };
  }

  @Post('notices')
  @UseGuards(AdminJwtGuard)
  // Redirect filter first so a guard rejection (AdminLoginRedirect) bounces to
  // login instead of the catch-all rendering admin/new with no session.
  @UseFilters(AdminLoginRedirectFilter, AdminCreateNoticeExceptionFilter)
  async createNotice(@Body() dto: CreateNoticeDto, @Res() res: Response) {
    const saved = await this.adminService.addNtm(dto);
    return res.render('admin/new', {
      page: 'new',
      title: 'Add notice',
      kinds: Object.values(NoticeKind),
      error: null,
      success: `Created ${saved.id} (${saved.title}).`,
      form: {},
    });
  }

  // HTMX-driven action endpoints. Each returns an empty 200 so the row,
  // targeted via `hx-target="closest tr" hx-swap="outerHTML"`, is removed
  // from the table. The actual mutation is handled by AdminService.
  @Post('notices/:id/approve')
  @UseGuards(AdminJwtGuard)
  @HttpCode(HttpStatus.OK)
  async approveNotice(@Param('id', ParseUUIDPipe) id: string) {
    await this.adminService.approveNtM(id);
    return '';
  }

  @Post('notices/:id/dismiss-reports')
  @UseGuards(AdminJwtGuard)
  @HttpCode(HttpStatus.OK)
  async dismissReports(@Param('id', ParseUUIDPipe) id: string) {
    await this.adminService.dismissReports(id);
    return '';
  }

  @Delete('notices/:id')
  @UseGuards(AdminJwtGuard)
  @HttpCode(HttpStatus.OK)
  async deleteNotice(@Param('id', ParseUUIDPipe) id: string) {
    await this.adminService.rejectNtM(id);
    return '';
  }

  private keyMatches(provided: string): boolean {
    const providedBuf = Buffer.from(provided);
    if (providedBuf.length !== this.adminKey.length) return false;
    return timingSafeEqual(providedBuf, this.adminKey);
  }
}

function paginationMeta<T>(page: Paginated<T>, filters: object = {}) {
  const pageHref = (offset: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      appendQueryParam(params, key, value);
    }
    params.set('offset', String(offset));
    params.set('limit', String(page.limit));
    return `?${params.toString()}`;
  };

  return {
    limit: page.limit,
    offset: page.offset,
    hasMore: page.hasMore,
    shown: page.items.length,
    nextOffset: page.offset + page.limit,
    prevOffset: Math.max(0, page.offset - page.limit),
    hasPrev: page.offset > 0,
    nextHref: pageHref(page.offset + page.limit),
    prevHref: pageHref(Math.max(0, page.offset - page.limit)),
  };
}

function appendQueryParam(
  params: URLSearchParams,
  key: string,
  value: unknown,
) {
  if (value === undefined || value === null || value === '') return;
  if (value instanceof Date) {
    params.set(key, value.toISOString());
    return;
  }
  if (typeof value === 'string') {
    params.set(key, value);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    params.set(key, String(value));
  }
}
