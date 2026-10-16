import ProjectItems from './ProjectItems';
import ProjectMeta from './ProjectMeta';
import { useProjectId } from './useProjectId';

// `<ProjectMembers>` — the members section a Project page ends with: the status
// rollup, the live board, and the completed board under its own heading.
//
// Placed by `projects/_layout.mdx`, so a project page's BODY carries only what is true
// of that project. It used to be pasted at the foot of every page, identically in all
// forty of them, which is a shape a layout owns rather than an author: the two pages
// written after the paste stopped happening both say "each item below" above nothing
// at all.
//
// **Why the headings live here and not in the layout.** The same layout wraps
// `projects/index.mdx`, a `kind: view` index with no members of its own. `<ProjectMeta>`
// and this component return `null` for a non-project entry, but markdown in a layout
// cannot decide not to render — a `## Members` line there would head an empty section on
// the index. The headings carry `.rm-members__h` because a layout renders OUTSIDE
// `.grove-prose` — prose typography does not reach them (`roadmap.css`).
//
// Gating the whole block behind one component is what lets the layout wrap
// the directory without special-casing anything in it, the same way `roadmap/_layout.mdx`
// relies on `<RoadmapMeta>` and `<Dependencies>` self-gating.
export default function ProjectMembers() {
  const id = useProjectId();
  if (!id) return null;

  return (
    <section className="rm-members">
      <h2 className="rm-members__h">Members</h2>
      <ProjectMeta />
      <ProjectItems groupBy="status" />
      <h3 className="rm-members__h" data-level="3">Completed</h3>
      <ProjectItems groupBy="status" scope="archive" />
    </section>
  );
}
