import { Transform, Type } from 'class-transformer';
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

// HTML forms send "" for empty optional inputs, which then trips IsDate /
// IsNumber after the value goes through Type/IsDate. These helpers coerce
// the empty case to undefined first so @IsOptional() short-circuits.
const optionalString = ({ value }: { value: unknown }) =>
  value === '' || value == null ? undefined : value;

const optionalDate = ({ value }: { value: unknown }) => {
  if (value === '' || value == null) return undefined;
  if (value instanceof Date) return value;
  return new Date(value as string | number);
};

const optionalNumber = ({ value }: { value: unknown }) => {
  if (value === '' || value == null) return undefined;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
};

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
  @Transform(optionalString)
  @IsString()
  subKey?: string;

  @IsOptional()
  @Transform(optionalString)
  @IsString()
  locationLabel?: string;

  @Type(() => Date)
  @IsDate()
  publishedAt!: Date;

  @Type(() => Date)
  @IsDate()
  activeFrom!: Date;

  @IsOptional()
  @Transform(optionalDate)
  @IsDate()
  activeTo?: Date;

  @IsOptional()
  @Transform(optionalNumber)
  @IsNumber()
  @Min(0)
  distance?: number;

  @IsOptional()
  @Transform(optionalNumber)
  @IsNumber()
  @Min(0)
  depth?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GeometryPartDto)
  areas?: GeometryPartDto[];
}
