export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Page { page: number; pageSize: number; offset: number }

export function pageMeta(page: Page, totalItems: number) {
  return { page: page.page, pageSize: page.pageSize, totalItems, totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / page.pageSize) };
}
