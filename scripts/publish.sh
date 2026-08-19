#!/usr/bin/env bash
# dsh-recover-context release helper: build, self-check, publish.
#
#   npm run release            → publish the CURRENT package.json version
#                                (use for the first release, or after you
#                                bumped the version yourself)
#   npm run release -- 1.0.1    → bump to 1.0.1 (no git tag; tag manually),
#                                then build/test/publish
#
# Version bumps never touch git (`--no-git-tag-version`), so a dirty working
# tree is fine; make your own git tags.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION_CMD="${1:-}"

if [[ -n "$VERSION_CMD" ]]; then
  npm version "$VERSION_CMD" --no-git-tag-version
fi

npm run build
npm test

echo "─── npm pack preview ───"
npm pack --dry-run

echo "─── publishing to npm (requires npm login) ───"
npm publish --access public

echo "─── done: v$(node -p "require('./package.json').version") published ───"
echo "reminder: tag and push when ready:"
echo "  git add package.json pnpm-lock.yaml && git commit -m 'chore: release v$(node -p "require('./package.json').version")'"
echo "  git tag v$(node -p "require('./package.json').version") && git push origin v$(node -p "require('./package.json').version")"
