import { ApiProperty } from '@nestjs/swagger';
import { NoticeKind } from '../../scraper/notice-kind';

export class NoticeKindMetricsDto {
  @ApiProperty({ enum: NoticeKind })
  kind!: NoticeKind;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  publicCount!: number;

  @ApiProperty()
  needsReviewCount!: number;
}

export class NoticeMetricsDto {
  @ApiProperty({ type: String, format: 'date-time' })
  asOf!: string;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  publicCount!: number;

  @ApiProperty()
  needsReviewCount!: number;

  @ApiProperty({
    description: 'Active notices currently visible on public map endpoints.',
  })
  activePublicCount!: number;

  @ApiProperty({
    description:
      'Active notices hidden from public map endpoints because they need team review.',
  })
  activeNeedsReviewCount!: number;

  @ApiProperty({ type: [NoticeKindMetricsDto] })
  byKind!: NoticeKindMetricsDto[];
}
