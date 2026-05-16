import * as Sentry from '@sentry/nestjs';
import type { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import type { Repository } from 'typeorm';
import { ScraperService } from './scraper.service';
import { NoticeToMariners } from './entities/notice-to-mariners.entity';
import { listNoticeLinks, type PdfLink } from './parser/notice-to-mariners';

jest.mock('./parser/notice-to-mariners', () => ({
  listNoticeLinks: jest.fn(),
}));

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
}));

const listNoticeLinksMock = jest.mocked(listNoticeLinks);
const captureExceptionMock = jest.mocked(Sentry.captureException);

function link(url: string): PdfLink {
  return {
    url,
    title: url,
    source: 'https://www.transport.gov.mt/maritime/notices',
  };
}

describe('ScraperService', () => {
  let repoFind: jest.MockedFunction<Repository<NoticeToMariners>['find']>;
  let getJobs: jest.MockedFunction<Queue['getJobs']>;
  let add: jest.MockedFunction<Queue['add']>;
  let ping: jest.Mock<Promise<string>, []>;
  let service: ScraperService;

  beforeEach(() => {
    repoFind = jest.fn<Repository<NoticeToMariners>['find']>();
    getJobs = jest.fn<Queue['getJobs']>();
    add = jest.fn<Queue['add']>();
    ping = jest.fn<Promise<string>, []>().mockResolvedValue('PONG');

    const queue = {
      add,
      getJobs,
      client: Promise.resolve({ ping }),
    } as unknown as Queue;
    const config = {
      getOrThrow: jest.fn(() => 2),
    } as unknown as ConfigService;

    service = new ScraperService(
      { find: repoFind } as unknown as Repository<NoticeToMariners>,
      queue,
      config,
    );

    listNoticeLinksMock.mockReset();
    captureExceptionMock.mockReset();
  });

  it('pings Redis through the BullMQ client', async () => {
    await expect(service.pingRedis()).resolves.toBe(true);
    expect(ping).toHaveBeenCalledTimes(1);
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
    expect(add).toHaveBeenNthCalledWith(1, 'notice-to-mariners', {
      url: 'https://example.com/new-1.pdf',
    });
    expect(add).toHaveBeenNthCalledWith(2, 'notice-to-mariners', {
      url: 'https://example.com/new-2.pdf',
    });
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

  it('reports scrape failures to Sentry before rethrowing', async () => {
    const error = new Error('upstream unavailable');
    listNoticeLinksMock.mockRejectedValue(error);

    await expect(service.scrapeNoticeToMariners()).rejects.toThrow(error);
    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      tags: { scraper: 'notice-to-mariners' },
    });
  });
});
