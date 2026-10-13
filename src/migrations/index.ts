// The numbered schema migrations, applied in order before the object serves (BATON_SPEC §3).
// A migration is never edited once merged: a change is a new file and a new entry here.
import init from './0001_init.sql';

export const MIGRATIONS: { id: number; sql: string }[] = [{ id: 1, sql: init }];
