import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDate,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  Validate,
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
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  long!: number;
}

// Minimum vertices each geometry type needs to be drawable: a point is one
// position, a line at least two, a polygon at least three (the serializer
// closes the ring). Enforced here so the admin form can't persist a degenerate
// shape that later serializes to null and silently disappears from the map.
const MIN_POINTS: Record<'point' | 'line' | 'polygon', number> = {
  point: 1,
  line: 2,
  polygon: 3,
};

@ValidatorConstraint({ name: 'pointCountMatchesType' })
class PointCountMatchesType implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const part = args.object as GeometryPartDto;
    const required = MIN_POINTS[part.geometryType];
    if (required === undefined) return true; // geometryType is validated separately
    return Array.isArray(part.points) && part.points.length >= required;
  }

  defaultMessage(args: ValidationArguments): string {
    const part = args.object as GeometryPartDto;
    const required = MIN_POINTS[part.geometryType] ?? 1;
    return `A ${part.geometryType} geometry needs at least ${required} point${
      required === 1 ? '' : 's'
    }.`;
  }
}

class GeometryPartDto {
  @IsString()
  label!: string;

  @IsIn(['point', 'line', 'polygon'])
  geometryType!: 'point' | 'line' | 'polygon';

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PointDto)
  @Validate(PointCountMatchesType)
  points!: PointDto[];
}

// The form ships geometry as a single hidden field holding a JSON string
// (urlencoded bodies can't carry an array of nested objects cleanly). Parse it
// into real GeometryPartDto instances here so @ValidateNested can see their
// metadata; leave anything unparseable as-is so @IsArray reports it.
const parseAreas = ({ value }: { value: unknown }) => {
  if (value === '' || value == null) return undefined;
  let raw: unknown = value;
  if (typeof value === 'string') {
    try {
      raw = JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (!Array.isArray(raw)) return raw;
  return raw.map((part) => plainToInstance(GeometryPartDto, part));
};

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
  @Transform(parseAreas)
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GeometryPartDto)
  areas?: GeometryPartDto[];
}
