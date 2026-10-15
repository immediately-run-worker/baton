// text.ts — §10.4's free text, as one pure predicate: every free-text field a worker or an
// owner sends, and every label a course file carries, is 1 to `max` characters (500 by default) with no control
// characters (C0, DEL or C1) and none of `< > { }`. validate.ts refuses with it; course.ts reports with it. Ticket titles are the one exception:
// they come from git and board.ts holds them only to a length and no C0 controls.

export const FREE_TEXT_MAX = 500;

export function isFreeText(v: unknown, max = FREE_TEXT_MAX): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f<>{}]/.test(v);
}
