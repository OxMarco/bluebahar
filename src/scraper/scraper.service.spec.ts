import type { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import type { Repository } from 'typeorm';
import { createHash } from 'node:crypto';
import { ScraperService } from './scraper.service';
import { NoticeToMariners } from './entities/notice-to-mariners.entity';
import { listNoticeLinks, type PdfLink } from './parser/notice-to-mariners';
import { Logs } from './entities/logs.entity';

jest.mock('./parser/notice-to-mariners', () => ({
  listNoticeLinks: jest.fn(),
}));

const listNoticeLinksMock = jest.mocked(listNoticeLinks);

function link(url: string): PdfLink {
  return {
    url,
    title: url,
    source: 'https://www.transport.gov.mt/maritime/notices',
  };
}

// Mirrors the deterministic jobId the service derives from each notice URL.
function jobId(url: string): string {
  return `ntm-${createHash('sha256').update(url).digest('hex')}`;
}

describe('ScraperService', () => {
  let repoFind: jest.MockedFunction<Repository<NoticeToMariners>['find']>;
  let getJobs: jest.MockedFunction<Queue['getJobs']>;
  let add: jest.MockedFunction<Queue['add']>;
  let logsDelete: jest.MockedFunction<Repository<Logs>['delete']>;
  let service: ScraperService;

  beforeEach(() => {
    repoFind = jest.fn() as jest.MockedFunction<
      Repository<NoticeToMariners>['find']
    >;
    getJobs = jest.fn() as jest.MockedFunction<Queue['getJobs']>;
    add = jest.fn() as jest.MockedFunction<Queue['add']>;
    logsDelete = jest.fn() as jest.MockedFunction<Repository<Logs>['delete']>;

    const queue = {
      add,
      getJobs,
    } as unknown as Queue;
    const config = {
      getOrThrow: jest.fn(() => 2),
    } as unknown as ConfigService;

    const logsRepo = {
      create: jest.fn((entity: unknown) => entity),
      save: jest.fn(),
      delete: logsDelete,
    } as unknown as Repository<Logs>;

    service = new ScraperService(
      { find: repoFind } as unknown as Repository<NoticeToMariners>,
      logsRepo,
      queue,
      config,
    );

    listNoticeLinksMock.mockReset();
  });

  it('enqueues only unseen, non-in-flight notices up to the configured batch size', async () => {
    listNoticeLinksMock.mockResolvedValue([
      link('https://example.com/stored.pdf'),
      link('https://example.com/in-flight.pdf'),
      link('https://example.com/new-1.pdf'),
      link('https://example.com/new-2.pdf'),
      link('https://example.com/new-3.pdf'),
    ]);
    repoFind.mockResolvedValue([
      { source: 'https://example.com/stored.pdf' } as NoticeToMariners,
    ]);
    getJobs.mockResolvedValue([
      {
        name: 'notice-to-mariners',
        data: { url: 'https://example.com/in-flight.pdf' },
      } as Job,
    ]);

    await expect(service.scrapeNoticeToMariners()).resolves.toEqual({
      message: 'Enqueued',
      enqueued: 2,
    });

    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenNthCalledWith(
      1,
      'notice-to-mariners',
      {
        url: 'https://example.com/new-1.pdf',
        title: 'https://example.com/new-1.pdf',
      },
      { jobId: jobId('https://example.com/new-1.pdf') },
    );
    expect(add).toHaveBeenNthCalledWith(
      2,
      'notice-to-mariners',
      {
        url: 'https://example.com/new-2.pdf',
        title: 'https://example.com/new-2.pdf',
      },
      { jobId: jobId('https://example.com/new-2.pdf') },
    );
  });

  it('does not enqueue when every discovered notice is already stored', async () => {
    listNoticeLinksMock.mockResolvedValue([
      link('https://example.com/stored.pdf'),
    ]);
    repoFind.mockResolvedValue([
      { source: 'https://example.com/stored.pdf' } as NoticeToMariners,
    ]);
    getJobs.mockResolvedValue([]);

    await expect(service.scrapeNoticeToMariners()).resolves.toEqual({
      message: 'No new notices',
      enqueued: 0,
    });
    expect(add).not.toHaveBeenCalled();
  });

  it('rethrows scrape failures for the Sentry cron instrumentation', async () => {
    const error = new Error('upstream unavailable');
    listNoticeLinksMock.mockRejectedValue(error);

    await expect(service.scrapeNoticeToMariners()).rejects.toThrow(error);
  });

  it('prunes logs older than the 14-day retention window', async () => {
    logsDelete.mockResolvedValue({ affected: 3, raw: [] });
    const before = Date.now() - 14 * 24 * 60 * 60 * 1000;

    await expect(service.pruneOldLogs()).resolves.toEqual({ deleted: 3 });

    const where = logsDelete.mock.calls[0]?.[0] as { createdAt: unknown };
    const cutoff = (where.createdAt as { value: Date }).value;
    // LessThan wraps the cutoff in a FindOperator; assert it's ~14 days back.
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 5000);
    expect(cutoff.getTime()).toBeLessThanOrEqual(
      Date.now() - 14 * 24 * 60 * 60 * 1000 + 5000,
    );
  });

  it('rethrows log-prune failures for the Sentry cron instrumentation', async () => {
    const error = new Error('db unavailable');
    logsDelete.mockRejectedValue(error);

    await expect(service.pruneOldLogs()).rejects.toThrow(error);
  });
});
