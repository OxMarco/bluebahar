import {
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Render,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { MapService } from './map.service';
import { GetNoticesDto } from './dto/get-notices.dto';

@Controller({
  path: '/map',
  version: '1',
})
export class MapController {
  constructor(private readonly mapService: MapService) {}

  @Get()
  @Render('map')
  root() {
    return { version: 'v1' };
  }

  @Get('notices')
  async getNotices(@Query() query: GetNoticesDto) {
    return this.mapService.getNotices(query);
  }

  @Post('notices/report/:id')
  async reportNotice(@Param('id') id: string) {
    return this.mapService.report(id);
  }

  @Get('notices/metrics')
  getNoticeMetrics() {
    return this.mapService.getNoticeMetrics();
  }

  @Get('datasets')
  listDatasets() {
    return this.mapService.listDatasets();
  }

  @Get('datasets/:key')
  @Header('Content-Type', 'application/geo+json')
  getDataset(
    @Param('key') key: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const dataset = this.mapService.requireDataset(key);
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
    return dataset.payload;
  }
}
