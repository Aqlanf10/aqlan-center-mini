#!/bin/sh
# Explicit syntax and static checks for every harness file, with the repository's pinned tooling
# (Node from .nvmrc/engines, ESLint, @eslint/js and TypeScript from package-lock.json).
# Usage, from the repository root: sh docs/review/finance-upgrade-proof/proof/static-checks.sh
set -eu
P=docs/review/finance-upgrade-proof/proof
echo "node $(node --version); eslint $(node -p 'require("./node_modules/eslint/package.json").version'); @eslint/js $(node -p 'require("./node_modules/@eslint/js/package.json").version'); typescript $(node -p 'require("./node_modules/typescript/package.json").version')"
echo "== node --check (syntax)"
for f in "$P"/*.mjs; do node --check "$f"; echo "ok $f"; done
echo "== eslint (dedicated harness config; the repository config ignores *.mjs)"
npx --no-install eslint --no-config-lookup -c "$P/static-checks.eslint.config.mjs" --max-warnings 0 "$P"/*.mjs
echo "ok eslint: $(ls "$P"/*.mjs | wc -l | tr -d ' ') files, 0 problems"
# Negative control: the same config must reject a file with an unused variable, == and an undefined name.
N="$P/.negative-control.mjs"
printf 'const unused = 1;\nconsole.log(unused == "1", undefinedName);\nconst dead = 2;\n' > "$N"
if npx --no-install eslint --no-config-lookup -c "$P/static-checks.eslint.config.mjs" "$N" >/dev/null 2>&1; then rm -f "$N"; echo "FAIL negative control passed"; exit 1; fi
rm -f "$N"; echo "ok eslint negative control rejected"
echo "== tsc --checkJs (types against pg/node declarations; unused locals and parameters)"
npx --no-install tsc --noEmit --allowJs --checkJs --skipLibCheck --noUnusedLocals --noUnusedParameters --noImplicitReturns \
  --noFallthroughCasesInSwitch --target es2022 --module nodenext --moduleResolution nodenext --types node "$P"/*.mjs
echo "ok tsc"
