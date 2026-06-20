import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  COMMUNITY_MAP_IMPORT_JOB,
  CommunityMapImportScheduler,
  communityMapImportJobId,
} from './community-map-import.scheduler';

function buildScheduler(enabled: boolean) {
  const config = {
    get: jest.fn().mockReturnValue(enabled),
  } as unknown as ConfigService;
  const add = jest.fn().mockResolvedValue(undefined);
  const queue = {
    add,
  } as unknown as Queue;
  return { scheduler: new CommunityMapImportScheduler(config, queue), add };
}

describe('CommunityMapImportScheduler', () => {
  it('enqueues one deterministic job for the UTC day', async () => {
    const { scheduler, add } = buildScheduler(true);
    const now = new Date('2026-06-19T23:55:00.000Z');

    await scheduler.enqueue(now);

    expect(add).toHaveBeenCalledWith(
      COMMUNITY_MAP_IMPORT_JOB,
      {},
      {
        jobId: 'community-map-import-2026-06-19',
      },
    );
    expect(communityMapImportJobId(now)).toBe(
      'community-map-import-2026-06-19',
    );
  });

  it('does not enqueue when map imports are disabled', async () => {
    const { scheduler, add } = buildScheduler(false);

    await scheduler.enqueue(new Date('2026-06-19T00:00:00.000Z'));

    expect(add).not.toHaveBeenCalled();
  });
});
