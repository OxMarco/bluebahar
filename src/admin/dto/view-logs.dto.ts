import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { LogType } from '../../scraper/log-type';

export class ViewLogsDto {
  @IsOptional()
  @IsEnum(LogType)
  logType?: LogType;

  // ISO date; only logs created at or after this instant are returned.
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  since?: Date;

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
