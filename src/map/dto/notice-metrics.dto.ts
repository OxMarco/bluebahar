import { NoticeKind } from '../../scraper/notice-kind';

export class NoticeKindMetricsDto {
  kind!: NoticeKind;
  total!: number;
  publicCount!: number;
  needsReviewCount!: number;
}

export class NoticeMetricsDto {
  asOf!: string;
  total!: number;
  publicCount!: number;
  needsReviewCount!: number;
  activePublicCount!: number;
  activeNeedsReviewCount!: number;
  byKind!: NoticeKindMetricsDto[];
}
