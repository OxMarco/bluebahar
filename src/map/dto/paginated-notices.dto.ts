import { ApiProperty } from '@nestjs/swagger';
import { NoticeDto } from './notice.dto';

export class PaginatedNoticesDto {
  @ApiProperty({ type: [NoticeDto] })
  items!: NoticeDto[];

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  offset!: number;

  @ApiProperty({
    description:
      'True when another page is likely available at offset + limit.',
  })
  hasMore!: boolean;
}
