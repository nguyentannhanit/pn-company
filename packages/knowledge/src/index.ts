/**
 * @pn/knowledge — phần suy luận thuần của Knowledge & R&D (§102, §111–§113,
 * §118–§120, §133).
 *
 * Không chạm database, không gọi model, không gọi mạng. Nhờ vậy mọi quy tắc
 * quyết định thứ gì được vào đầu agent đều kiểm chứng được bằng test.
 */

export * from './scoring.js';
export * from './screening.js';
export * from './xp.js';
