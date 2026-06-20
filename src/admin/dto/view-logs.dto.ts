import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsOptional } from 'class-validator';
import { LogType } from '../../common/log-type';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ViewLogsDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(LogType)
  logType?: LogType;

  // ISO date; only logs created at or after this instant are returned.
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  since?: Date;
}
