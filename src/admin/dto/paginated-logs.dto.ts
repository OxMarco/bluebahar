import { Logs } from '../../scraper/entities/logs.entity';

export class PaginatedLogsDto {
  items!: Logs[];
  limit!: number;
  offset!: number;
  hasMore!: boolean;
}
