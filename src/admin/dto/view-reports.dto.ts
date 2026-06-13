import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ViewReportsDto extends PaginationQueryDto {
  // The admin queue defaults to open (unresolved) reports; pass resolved=true to
  // review the actioned ones. Mirrors GetNoticesDto's boolean coercion.
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  resolved: boolean = false;
}
