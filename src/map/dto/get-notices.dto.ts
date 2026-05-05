import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { NoticeKind } from '../../scraper/notice-kind';

export class GetNoticesDto {
  @ApiPropertyOptional({
    enum: NoticeKind,
    description: 'Filter notices by kind.',
  })
  @IsOptional()
  @IsEnum(NoticeKind)
  kind?: NoticeKind;

  @ApiPropertyOptional({
    type: Boolean,
    default: true,
    description:
      'When true, only return notices currently active (activeFrom <= now and activeTo >= now or null).',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  activeOnly?: boolean = true;

  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: 500,
    default: 100,
    description: 'Maximum number of notices to return.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;

  @ApiPropertyOptional({
    type: Number,
    minimum: 0,
    default: 0,
    description: 'Number of notices to skip for pagination.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}
