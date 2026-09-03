# Contributing

Thanks for helping. This kit is deliberately small: two files, no build step,
no runtime dependencies. Keep it that way.

## Ground rules

- **Zero dependencies, zero build.** A change that needs a bundler, a
  transpiler or an npm package will not be merged.
- **The contract is the API, not this repo.** Behavior follows
  <https://intake.hellojade.ai/api/openapi.json> and
  <https://intake.hellojade.ai/api/INTEGRATION.md>. If they disagree with this
  code, the code is wrong; open an issue quoting the spec.
- **Never post a real-looking lead to production** while developing. The
  tests run against a local stub. The only live call that is ever appropriate
  is the key check (`POST {}` → `422`), which stores nothing.
- **No secrets in the tree.** `grep -rn "X-API-Key" .` before every push and
  make sure every value is a placeholder.
- American English in code, comments and docs.

## Running the tests

```sh
npm run check         # syntax check of both modules
npm test              # node:test against a local stub (Node 18+), 28 tests
npm run test:browser  # real Chrome, 21 checks; LOCAL ONLY
```

`npm test` runs the same `hellojade-intake.js` the browser loads — it uses only
`fetch`, `AbortController` and `crypto`, so Node needs no shim.

`npm run test:browser` starts a static server and a stub intake API, checks out a
**headless** instance from the local chrome fleet, exercises the element end to
end (202, 200 duplicate, 422 field errors, 503 and 429 retries, client-side
validation, the honeypot, relay mode), and writes screenshots at 360 and 1280 to
`test/browser/out/`. It needs the fleet, so it is not in CI — **read the
screenshots**, the gates cannot see overlapping text or a wrapped label.

## Sending a change

1. Fork, branch from `main`.
2. Add or update a test in `test/client.test.mjs` for any client change, and
   a check in `test/browser/run.sh` for any element change.
3. Update `CHANGELOG.md` under an "Unreleased" heading.
4. Open a pull request with the failing status codes you exercised.

## Releasing

Tags on GitHub only. **This package is not published to npm** and CI does not
publish anywhere; `package.json` carries `"private": true` so an accidental
`npm publish` is refused.

1. Run both suites locally, including the real-Chrome one:
   `npm run check && npm test && npm run test:browser`. The browser test is not
   in CI, so a tag is the only place it is enforced — run it and read the
   screenshots it writes to `test/browser/out/`.
2. Bump `version` in `package.json` and the exported `VERSION` constant in
   `hellojade-intake.js`. They must match — nothing enforces it, and `VERSION`
   is what a partner reads to tell us which build they are running. (A browser
   cannot set `User-Agent`, so unlike the server kits this one does not
   identify itself on the wire.)
3. Move the `Unreleased` entries in `CHANGELOG.md` under the new version and date.
4. Commit, then `git tag -a vX.Y.Z -m "vX.Y.Z"` and push the tag.

Partners pin a tag, so a tag is immutable once pushed. Ship a new patch rather
than moving one.
