# Publishing `hiapi` to npm

The package builds ESM + CJS + type declarations via `prepack`, so a plain
`npm publish` ships a complete artifact. Tests gate every path.

## First release (manual)

```bash
# 1. Sanity: unit tests + build + ESM/CJS/types smoke checks.
npm test

# 2. Log in once on this machine (needs the npm account that owns the name).
npm login

# 3. Publish. prepack builds dist/ automatically.
npm publish --access public

# 4. Verify.
npm view hiapi version
```

## Later releases (CI, triggered by pushing to main)

`.github/workflows/publish.yml` runs on every push to `main` — NOT on a
pushed tag. It checks the npm registry directly for whether
`package.json`'s current version is already published; if not, it publishes
with npm [provenance](https://docs.npmjs.com/generating-provenance-statements)
(requires the GitHub repo to be public), then creates and pushes a `vX.Y.Z`
git tag as a record of the release (not as what triggered it). If that
version is already on npm, the whole run is a no-op except for making sure
the tag exists — safe to push to main any number of times without bumping
the version.

One-time setup: create a **granular automation token** on npmjs.com (Packages:
Read and write, bypasses 2FA/OTP) and store it as the `NPM_TOKEN` secret in the
`HiAPIAI/hiapi-node` repository settings.

Per release:

```bash
# 1. Bump the version in BOTH places (a unit test enforces they match):
#    - package.json        "version"
#    - src/version.ts      VERSION
# 2. Commit, push to main.
git commit -am "release: vX.Y.Z"
git push origin main
```

That's it — do **not** create the `vX.Y.Z` tag yourself; the workflow does
that after a successful publish. Pushing it ahead of time doesn't skip
anything (the workflow doesn't look at tags to decide whether to publish),
but there's no reason to.

## Notes

- **Versions are immutable** on npm; a mistake means publishing a new patch
  version (`npm unpublish` is heavily restricted after 72 hours).
- The tarball contains only `dist/`, `README.md`, `LICENSE` (see `files` in
  `package.json`); check with `npm pack --dry-run`.
- The README shown on npmjs.com is frozen per version — README-only fixes need
  a patch release to refresh the page (same lesson as PyPI).
