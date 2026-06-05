import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { NoticeKind } from '../../scraper/notice-kind';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class GetNoticesDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(NoticeKind)
  kind?: NoticeKind;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  activeOnly?: boolean = true;
}
