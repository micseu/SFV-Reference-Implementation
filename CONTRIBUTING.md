# Contributing

Work on a branch and submit a focused Pull Request. Keep `main` working.
Before committing inspect `git status`, `git diff`, `git diff --check` and run
project tests documented in `README.md`. Use small, meaningful commits.
Keep source/configuration in Git, not caches, `node_modules`, `out/`, virtual
environments, IDE files, secrets or raw experiment outputs. Use project-relative
paths and document nontrivial public contracts and side effects. Record exact
experiment inputs, seeds, runtime versions and source revisions with outputs.

## Linting and formatting

ESLint (`eslint.config.js`) and Prettier (`.prettierrc.json`) check all code.
Run `npm run format` and `npm run lint` before committing; `npm run lint:fix`
fixes what it can automatically. `npm run verify`, which CI runs, fails on lint
errors or unformatted files. Do not mix bulk reformatting with other changes.

ABR rules in `src/rules/` must stay pure and deterministic: ESLint rejects
`fetch`, `window`, `document`, `Date.now()` and `performance.now()` there. Use
`getCurrentTime()` and the other data on the rules context
(`src/core/SFVRulesContext.js`) instead.

The Prettier reformat is listed in `.git-blame-ignore-revs`. To have local
`git blame` skip it, run once per clone:

    git config blame.ignoreRevsFile .git-blame-ignore-revs

If you commit another bulk reformat, add its full hash to that file.
