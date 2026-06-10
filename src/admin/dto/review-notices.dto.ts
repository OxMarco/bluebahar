import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { GetNoticesDto } from '../../map/dto/get-notices.dto';

// The review queue must surface notices BEFORE they go live — a flagged notice
// with a future activeFrom is exactly what a human wants to vet — so unlike
// the public endpoint, activeOnly defaults to false here.
export class ReviewNoticesDto extends GetNoticesDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  activeOnly?: boolean = false;
}
