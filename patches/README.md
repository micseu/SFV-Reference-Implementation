# dash.js integration patch

Use **only** `dashjs-b1bde9f-CONSOLIDATED.patch` on upstream dash.js commit
`b1bde9f45f35e4565eaeb1ea4dfd6a5f8fd44bdb`.

Run `node scripts/prepare-dashjs.mjs ../dash.js --check`, then `--apply` **once**,
then `--verify-installed`. The installer also updates two upstream public-API
surface test entries. Do not apply older, incremental patches or repeat `--apply`
on an already patched checkout. See `docs/GETTING_STARTED.md`.
