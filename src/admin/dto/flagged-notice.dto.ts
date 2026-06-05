import { NoticeDto } from '../../map/dto/notice.dto';
import { Paginated } from '../../common/dto/paginated.dto';

// Wraps the public NoticeDto with admin-only fields (the user-report count).
// Kept separate so the public /v1/map serializer doesn't leak report counts.
export class FlaggedNoticeDto extends NoticeDto {
  reports!: number;
}

export class PaginatedFlaggedNoticesDto extends Paginated<FlaggedNoticeDto> {}
