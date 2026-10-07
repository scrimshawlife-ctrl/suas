# Releasing the SUAS Worker

The Worker uses [Semantic Versioning](https://semver.org/) and stays below
1.0.0 while SPEC-018 (launch readiness) is blocked. A version or tag is not
permission to deploy to production, run a pilot, or use real Veteran data.

The application version is separate from the SUAS-specs stack version. Every
release states the stack it implements, for example "Implements SUAS-specs
0.6.0" (SUAS-specs `VERSIONING.md` sections 3 and 8). The spec pin itself lives
in `src/release/pins.ts`.

## Version rules (pre-1.0)

- MINOR (`0.x.0`): new behavior, a new script or workflow, or a change native
  clients need to know about.
- PATCH (`0.x.y`): fixes and docs only, no behavior change for clients.
- A change to `/api/v0`, auth, the Veteran journey, or environment class must
  be considered against `suas-ios` and `suas-android` too.

## Steps

1. On the feature or docs branch, bump the version without tagging:

   ```bash
   npm version 0.3.0 --no-git-tag-version   # updates package.json and package-lock.json
   ```

2. In `CHANGELOG.md`, move the `[Unreleased]` entries under a new
   `## [0.3.0] - YYYY-MM-DD` heading, add the "Implements SUAS-specs x.y.z"
   line, and update the compare links at the bottom.
3. Open the PR and get CI green. Merging needs Danny's yes.
4. After the merge, tag the merge commit on `main` and push the tag:

   ```bash
   git checkout main && git pull
   git tag -a v0.3.0 -m "suas v0.3.0 (implements SUAS-specs 0.6.0)"
   git push origin v0.3.0
   ```

5. The `release` workflow (`.github/workflows/release.yml`) creates the GitHub
   Release from the pushed `v*` tag, using that version's `CHANGELOG.md`
   section as the notes. To do it by hand instead:

   ```bash
   gh release create v0.3.0 --verify-tag --title "suas v0.3.0" --notes-file <(awk '/^## \[0.3.0\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md)
   ```

Tagging does not deploy. Synthetic STAGING is deployed only by running the
`worker-deploy` workflow by hand; see
[docs/runbooks/cloudflare-workers.md](docs/runbooks/cloudflare-workers.md).
