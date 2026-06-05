import { Logs } from '../../scraper/entities/logs.entity';
import { Paginated } from '../../common/dto/paginated.dto';

export class PaginatedLogsDto extends Paginated<Logs> {}
