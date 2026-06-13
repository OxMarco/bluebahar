import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { MapService } from './map.service';
import { CreateReportDto } from './dto/create-report.dto';
import { GetNoticesDto } from './dto/get-notices.dto';

// Dataset content mutates under a stable URL (DatasetRefreshService swaps it in
// place), and clients gate freshness on the cache manifest's revision, not on
// elapsed time. So we must never let a cache serve a payload blindly: `no-cache`
// keeps it stored but forces an ETag revalidation on every reuse. Unchanged ->
// 304 (no body re-transfer, the bandwidth win we're after); changed -> a fresh
// 200. A max-age here would instead let a client keep serving a stale layer for
// the whole window even after the manifest said it changed.
const REVALIDATE_CACHE_CONTROL = 'no-cache';

// Matches a client's If-None-Match against our strong ETag. Honors the list
// form ("a", "b") and the "*" wildcard, and ignores any weak ("W/") prefix a
// proxy may have added since our ETags are content-stable either way.
function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch
    .split(',')
    .map((token) => token.trim().replace(/^W\//, ''))
    .includes(etag);
}

@Controller({
  path: '/map',
  version: '1',
})
export class MapController {
  constructor(private readonly mapService: MapService) {}

  @Get('notices')
  async getNotices(@Query() query: GetNoticesDto) {
    return this.mapService.getNotices(query);
  }

  @Post('notices/report/:id')
  async reportNotice(@Param('id', ParseUUIDPipe) id: string) {
    return this.mapService.report(id);
  }

  // Crowd-sourced report against a tapped point (a wreck, a hazard, …). Public
  // and unauthenticated like the notice flag above; the global throttler guards
  // against abuse and the body is validated by CreateReportDto.
  @Post('reports')
  async createReport(@Body() dto: CreateReportDto) {
    return this.mapService.createReport(dto);
  }

  @Get('notices/metrics')
  getNoticeMetrics() {
    return this.mapService.getNoticeMetrics();
  }

  // Tiny change-detection token the app polls on focus/reconnect to decide
  // whether its cached datasets / notices are stale, instead of re-fetching
  // them speculatively. See CacheManifestDto.
  @Get('manifest')
  getManifest() {
    return this.mapService.getManifest();
  }

  @Get('datasets')
  listDatasets(
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ) {
    // The catalog revision is a content hash over every served layer, so it's a
    // natural strong ETag for the metadata list.
    const etag = `"${this.mapService.datasetsRevision()}"`;
    res.set('Cache-Control', REVALIDATE_CACHE_CONTROL);
    res.set('ETag', etag);
    if (etagMatches(ifNoneMatch, etag)) {
      res.status(304).end();
      return;
    }
    res.json(this.mapService.listDatasets());
  }

  @Get('datasets/:key')
  getDataset(
    @Param('key') key: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ) {
    // Throws (404/503) before we touch the response, so the global exception
    // filters still own those paths.
    const dataset = this.mapService.requireDataset(key);
    // The payload sha256 is already computed at load time — a stable, strong
    // ETag that lets repeat fetches of an unchanged dataset 304 out.
    const etag = `"${dataset.metadata.sha256}"`;
    res.set('Content-Type', 'application/geo+json');
    res.set('Cache-Control', REVALIDATE_CACHE_CONTROL);
    res.set('ETag', etag);
    res.set('X-Dataset-Key', dataset.metadata.key);
    res.set('X-Dataset-Kind', dataset.metadata.kind);
    res.set('X-Dataset-Feature-Count', String(dataset.metadata.featureCount));
    res.set(
      'X-Dataset-Geometry-Types',
      dataset.metadata.geometryTypes.join(','),
    );
    if (dataset.metadata.bbox) {
      res.set('X-Dataset-BBox', dataset.metadata.bbox.join(','));
    }
    if (etagMatches(ifNoneMatch, etag)) {
      res.status(304).end();
      return;
    }
    res.send(dataset.payload);
  }
}
