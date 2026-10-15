// text.ts — §10.4's free text, as one pure predicate: every free-text field Baton stores or
// shows (a title, a label, a note) is 1 to `max` characters (500 by default) with no control
// characters (C0, DEL or C1) and none of `< > { }`. validate.ts refuses with it; course.ts reports with it.

export const FREE_TEXT_MAX = 500;

export function isFreeText(v: unknown, max = FREE_TEXT_MAX): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f<>{}]/.test(v);
}
