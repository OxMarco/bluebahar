import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// Trims surrounding whitespace before validation so a title of only spaces is
// rejected by IsNotEmpty rather than slipping through.
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateReportDto {
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(1000)
  description!: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;
}
