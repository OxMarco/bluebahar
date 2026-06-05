// Shared envelope for paginated list responses. `hasMore` lets clients page
// without a separate total-count query.
export class Paginated<T> {
  items!: T[];
  limit!: number;
  offset!: number;
  hasMore!: boolean;
}

export function toPaginated<T, U = T>(
  rows: T[],
  limit: number,
  offset: number,
  mapItem: (row: T) => U = (row) => row as unknown as U,
): Paginated<U> {
  return {
    items: rows.slice(0, limit).map(mapItem),
    limit,
    offset,
    hasMore: rows.length > limit,
  };
}
