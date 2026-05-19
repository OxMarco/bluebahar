import { NoticeDto } from './notice.dto';

export class PaginatedNoticesDto {
  items!: NoticeDto[];
  limit!: number;
  offset!: number;
  hasMore!: boolean;
}
