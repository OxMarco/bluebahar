import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ViewFlaggedDto extends PaginationQueryDto {
  // Lower bound (inclusive) on user reports; defaults to flagged-only (>= 1).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minReports: number = 1;
}
