import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class ViewFlaggedDto {
  // Lower bound (inclusive) on user reports; defaults to flagged-only (>= 1).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minReports: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}
