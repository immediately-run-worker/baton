// The numbered schema migrations, applied in order before the object serves (BATON_SPEC §3).
// A migration is never edited once merged: a change is a new file and a new entry here.
import init from './0001_init.sql';
import workers from './0002_workers.sql';
import claims from './0003_claims.sql';
import cutover from './0004_cutover.sql';
import tickets from './0005_tickets.sql';
import repositories from './0006_repositories.sql';
import courses from './0007_courses.sql';

export const MIGRATIONS: { id: number; sql: string }[] = [
  { id: 1, sql: init },
  { id: 2, sql: workers },
  { id: 3, sql: claims },
  { id: 4, sql: cutover },
  { id: 5, sql: tickets },
  { id: 6, sql: repositories },
  { id: 7, sql: courses },
];
