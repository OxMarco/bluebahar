import { Type } from 'class-transformer';
import {
  IsArray,
  IsDate,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { NoticeKind } from '../../scraper/notice-kind';

class PointDto {
  @IsNumber()
  lat!: number;

  @IsNumber()
  long!: number;
}

class GeometryPartDto {
  @IsString()
  label!: string;

  @IsIn(['point', 'line', 'polygon'])
  geometryType!: 'point' | 'line' | 'polygon';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PointDto)
  points!: PointDto[];
}

export class CreateNoticeDto {
  @IsEnum(NoticeKind)
  kind!: NoticeKind;

  @IsString()
  title!: string;

  @IsString()
  description!: string;

  @IsString()
  source!: string;

  @IsOptional()
  @IsString()
  subKey?: string;

  @IsOptional()
  @IsString()
  locationLabel?: string;

  @Type(() => Date)
  @IsDate()
  publishedAt!: Date;

  @Type(() => Date)
  @IsDate()
  activeFrom!: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  activeTo?: Date;

  @IsOptional()
  @IsNumber()
  @Min(0)
  distance?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  depth?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GeometryPartDto)
  areas?: GeometryPartDto[];
}
