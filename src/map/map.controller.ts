import {
  Controller,
  Get,
  Header,
  Headers,
  HttpStatus,
  Param,
  Query,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import { CacheInterceptor } from '@nestjs/cache-manager';
import type { Response } from 'express';
import { MapService } from './map.service';
import { GetNoticesDto } from './dto/get-notices.dto';

@Controller({
  path: '/map',
  version: '1',
})
export class MapController {
  constructor(private readonly mapService: MapService) {}

  @UseInterceptors(CacheInterceptor)
  // Hint for upstream proxies (Traefik / CDN). Independent of the in-memory
  // CacheInterceptor; the value is the public cache window, not the server TTL.
  @Header('Cache-Control', 'public, max-age=300')
  @Get('notices')
  async getNotices(@Query() query: GetNoticesDto) {
    return this.mapService.getNotices(query);
  }

  @Get('notices/review')
  async getNoticesInReview(@Query() query: GetNoticesDto) {
    return this.mapService.getNotices(query, true);
  }

  @Header('Cache-Control', 'no-store')
  @Get('notices/metrics')
  getNoticeMetrics() {
    return this.mapService.getNoticeMetrics();
  }

  @UseInterceptors(CacheInterceptor)
  @Header('Cache-Control', 'public, max-age=300')
  @Get('datasets')
  listDatasets() {
    return this.mapService.listDatasets();
  }

  @Get('datasets/:key')
  @Header('Content-Type', 'application/geo+json')
  @Header('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400')
  getDataset(
    @Param('key') key: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const dataset = this.mapService.requireDataset(key);
    const etag = `"${dataset.metadata.sha256}"`;
    // sha256 is computed once at boot off the same payload we're sending, so a
    // matching If-None-Match short-circuits to 304 without ever serializing.
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
      res.status(HttpStatus.NOT_MODIFIED);
      return null;
    }
    return dataset.payload;
  }
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === etag || candidate === '*');
}
