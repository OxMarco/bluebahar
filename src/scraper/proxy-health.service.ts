import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';
import { proxiedImpit } from '../common/utils/http';

// Cheap liveness endpoint: Cloudflare echoes `warp=on` only when the request
// actually egresses through a live WARP tunnel. A reachable proxy whose tunnel
// is dead returns `warp=off` (or the fetch throws a SOCKS error), which is
// exactly the "proxy up, daemon dead" failure that silently broke the Transport
// Malta scraper for ~9 days before the twice-daily cron surfaced it.
const TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
const CHECK_TIMEOUT_MS = 15_000;

// Proactively monitors the WARP scraper egress so its connection failures reach
// Sentry within minutes as their own alertable issue, instead of only showing
// up (lumped into "all listing sources failed") when the 12-hourly scrape runs.
@Injectable()
export class ProxyHealthService {
  private readonly logger = new Logger(ProxyHealthService.name);
  // proxiedImpit falls back to the direct client when SCRAPER_PROXY_URL is
  // unset (local/dev) — there's no tunnel to check there, so skip.
  private readonly enabled = Boolean(process.env.SCRAPER_PROXY_URL?.trim());
  // Edge-triggered: capture once on the healthy→down transition and once on
  // recovery, so a multi-day outage produces two events, not thousands.
  private down = false;

  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'warp-proxy-health' })
  async checkProxy(): Promise<void> {
    if (!this.enabled) return;

    try {
      const res = await proxiedImpit.fetch(TRACE_URL, {
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      const body = await res.text();
      const warp = /warp=(\w+)/.exec(body)?.[1] ?? 'unknown';
      if (!res.ok || warp !== 'on') {
        // Reachable but not tunnelling — the daemon-dead state. Throw so it's
        // handled identically to a hard SOCKS/connect failure below.
        throw new Error(
          `WARP egress reachable but tunnel inactive (status ${res.status}, warp=${warp})`,
        );
      }

      if (this.down) {
        this.down = false;
        this.logger.log('WARP scraper proxy egress recovered');
        Sentry.captureMessage('WARP scraper proxy egress recovered', {
          level: 'info',
          tags: { scraper: 'warp-proxy', state: 'recovered' },
        });
      }
    } catch (err) {
      if (this.down) {
        // Already reported this outage — log only, don't re-spam Sentry.
        this.logger.warn('WARP scraper proxy egress still down');
        return;
      }
      this.down = true;
      this.logger.error('WARP scraper proxy egress down', err as Error);
      // Single fingerprint so every outage groups into one issue you can alert
      // on, regardless of whether it was a SOCKS error or warp=off this time.
      Sentry.captureException(err, {
        level: 'error',
        tags: { scraper: 'warp-proxy', state: 'down' },
        fingerprint: ['warp-proxy-egress-down'],
        extra: { proxyUrl: process.env.SCRAPER_PROXY_URL, traceUrl: TRACE_URL },
      });
    }
  }
}
