import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import { CacheInterceptor } from '@nestjs/cache-manager';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiUnprocessableEntityResponse,
  ApiParam,
  ApiProduces,
} from '@nestjs/swagger';
import { resolve } from 'node:path';
import type { Response } from 'express';
import { MapService } from './map.service';
import { GetNoticesDto } from './dto/get-notices.dto';
import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';
import { Weather } from '../scraper/entities/weather.entity';
import { Dataset } from '../scraper/entities/dataset.entity';

@ApiTags('Map')
@Controller({
  path: '/map',
  version: '1',
})
export class MapController {
  constructor(private readonly mapService: MapService) {}

  @UseInterceptors(CacheInterceptor)
  @Get('notices')
  @ApiOperation({
    summary: 'List notices to mariners',
    description:
      'Returns a paginated list of notices to mariners, optionally filtered by kind and active status. Results are ordered by activeFrom descending.',
  })
  @ApiOkResponse({
    description: 'A list of notices to mariners.',
    type: NoticeToMariners,
    isArray: true,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Invalid query parameters.',
  })
  async getNotices(@Query() query: GetNoticesDto) {
    return this.mapService.getNotices(query);
  }

  @UseInterceptors(CacheInterceptor)
  @Get('weather')
  @ApiOperation({
    summary: 'Get latest weather report',
    description:
      'Returns the most recently published weather report, or null if none has been ingested yet.',
  })
  @ApiOkResponse({
    description: 'The latest weather report.',
    type: Weather,
  })
  async getWeather() {
    return this.mapService.getWeather();
  }

  @UseInterceptors(CacheInterceptor)
  @Get('datasets')
  @ApiOperation({
    summary: 'List available GeoJSON datasets',
    description:
      'Returns metadata for every available dataset (key, name, source URL, feature count, byte size, sha256, fetch/update timestamps). Use the key with GET /map/datasets/:key to download the GeoJSON file.',
  })
  @ApiOkResponse({
    description: 'Metadata for every available dataset.',
    type: Dataset,
    isArray: true,
  })
  async listDatasets() {
    return this.mapService.listDatasets();
  }

  @Get('datasets/:key')
  @ApiOperation({
    summary: 'Download a GeoJSON dataset',
    description:
      'Streams the GeoJSON file for the dataset identified by `key`. Responses are cacheable for one hour.',
  })
  @ApiParam({
    name: 'key',
    description: 'Unique dataset identifier as returned by GET /map/datasets.',
    type: String,
  })
  @ApiProduces('application/geo+json')
  @ApiOkResponse({
    description: 'The GeoJSON file contents.',
    content: {
      'application/geo+json': {
        schema: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'No dataset exists for the given key.' })
  async getDataset(@Param('key') key: string, @Res() res: Response) {
    const dataset = await this.mapService.getDataset(key);
    if (!dataset) throw new NotFoundException(`Unknown dataset: ${key}`);

    res.type('application/geo+json');
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(resolve(dataset.filePath), { lastModified: true });
  }
}
