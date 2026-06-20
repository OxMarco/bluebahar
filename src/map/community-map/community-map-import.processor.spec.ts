import type { Job } from 'bullmq';
import { CommunityMapImportProcessor } from './community-map-import.processor';
import type { CommunityMapImportService } from './community-map-import.service';
import { COMMUNITY_MAP_IMPORT_JOB } from './community-map-import.scheduler';

function job(name: string): Job {
  return { name } as Job;
}

describe('CommunityMapImportProcessor', () => {
  it('runs the community-map importer', async () => {
    const importCommunityMap = jest.fn().mockResolvedValue(undefined);
    const importer = {
      importCommunityMap,
    } as unknown as CommunityMapImportService;
    const processor = new CommunityMapImportProcessor(importer);

    await processor.process(job(COMMUNITY_MAP_IMPORT_JOB));

    expect(importCommunityMap).toHaveBeenCalledTimes(1);
  });

  it('propagates import failures so BullMQ retries the job', async () => {
    const error = new Error('Google temporarily unavailable');
    const importer = {
      importCommunityMap: jest.fn().mockRejectedValue(error),
    } as unknown as CommunityMapImportService;
    const processor = new CommunityMapImportProcessor(importer);

    await expect(processor.process(job(COMMUNITY_MAP_IMPORT_JOB))).rejects.toBe(
      error,
    );
  });

  it('rejects unknown job names', async () => {
    const importCommunityMap = jest.fn();
    const importer = {
      importCommunityMap,
    } as unknown as CommunityMapImportService;
    const processor = new CommunityMapImportProcessor(importer);

    await expect(processor.process(job('other'))).rejects.toThrow('Unknown');
    expect(importCommunityMap).not.toHaveBeenCalled();
  });
});
