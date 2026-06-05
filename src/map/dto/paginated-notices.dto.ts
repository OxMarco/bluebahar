import { NoticeDto } from './notice.dto';
import { Paginated } from '../../common/dto/paginated.dto';

export class PaginatedNoticesDto extends Paginated<NoticeDto> {}
