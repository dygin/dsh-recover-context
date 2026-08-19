#!/usr/bin/env bash
# dsh-recover-context release helper: build, self-check, version, publish.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION_CMD="${1:-patch}"   # patch | minor | major | <explicit-version>

if [[ "$VERSION_CMD" =~ ^(patch|minor|major)$ ]]; then
  npm version "$VERSION_CMD"
else
  npm version "$VERSION_CMD"
fi

npm run build
npm test

# Show what will be shipped before publishing.
echo "─── npm pack preview ───"
npm pack --dry-run

echo "─── publishing to npm (requires npm login) ───"
npm publish --access public

echo "─── done: tag and push ───"
TAG="v$(node -p "require('./package.json').version")"
echo "git tag $TAG && git push origin $TAG"
