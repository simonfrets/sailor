import { z } from "zod";

const ABSOLUTE_OR_ESCAPING = /^\/|(?:^|\/)\.\.(?:\/|$)|\\/;

/**
 * A path naming something inside the project.
 *
 * `tasks.yaml` is committed and reviewed in a pull request, so an absolute path
 * in it would publish the machine that wrote it and would mean nothing on the
 * next one. A `..` segment is refused for the same reason a run id is
 * constrained: a recorded path is later resolved against the project root, and
 * one that escapes it points at a file the sailor never owned.
 *
 * It lives here rather than beside the task schema that first needed it because
 * an agent's write scopes are the same kind of value and are declared in
 * `.sailor/agents/`, which knows nothing about tasks.
 */
export const projectRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !ABSOLUTE_OR_ESCAPING.test(value),
    "must be a relative path inside the project, with `/` separators and no `..` segment"
  );

/**
 * The glob constructs that let one pattern name more than one starting point:
 * brace expansion, extglob groups and their alternation bar, a leading negation,
 * and bracket expressions.
 */
const GLOB_ALTERNATION = /[!()[\]{}|]/;

/**
 * A glob naming files inside the project, as an agent's write scopes do.
 *
 * The path constraint above is necessary and not sufficient, because a glob has
 * more ways to spell a path than a path does. Every one of `{..,src}/**`,
 * `@(..|src)/**` and `[.][.]/**` satisfies it - none contains a leading `/`, a
 * `..` segment or a backslash - and `minimatch` matches `../outside.txt`
 * against all three. `{/etc,src}/**` and `!(src)/**` reach `/etc/passwd` the
 * same way. So the constructs are refused rather than inspected: checking that
 * every path a pattern could expand to stays inside the project means
 * implementing brace expansion in a validator, and two scopes say what one
 * alternation was trying to.
 *
 * What is left is `*`, `**` and `?`, which is what every shipped scope uses and
 * what a write scope means: a subtree of the project, named once.
 *
 * This matters more than a recorded path does. Design decision 6 puts tool
 * enforcement in the runtime rather than in the prompt, and a write scope is
 * what the runtime will read to decide which files an agent may change, so a
 * scope that escapes the project is a grant, not a diagnostic.
 */
export const projectRelativeGlobSchema = projectRelativePathSchema.refine(
  (value) => !GLOB_ALTERNATION.test(value),
  "must be a glob whose only wildcards are `*`, `**` and `?`: a brace, group or bracket expression can name a path outside the project without containing one"
);
