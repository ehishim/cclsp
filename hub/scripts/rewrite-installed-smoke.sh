#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo"
runtime=$(mktemp -d "${TMPDIR:-/tmp}/cclsp-rewrite-runtime-XXXXXX")
root=$(mktemp -d "${TMPDIR:-/tmp}/cclsp-rewrite-root-XXXXXX")
stale_root=$(mktemp -d "${TMPDIR:-/tmp}/cclsp-rewrite-stale-XXXXXX")
bin=$(mktemp -d "${TMPDIR:-/tmp}/cclsp-rewrite-bin-XXXXXX")
hub="$bin/cclsp-hub"
cleanup(){
  env XDG_RUNTIME_DIR="$runtime" CCLSP_HUB_CONFIG="$root/cclsp.json" "$hub" shutdown >/dev/null 2>&1 || true
  rm -rf "$runtime" "$root" "$stale_root" "$bin"
}
trap cleanup EXIT

(cd hub && CCLSP_HUB_BIN_DIR="$bin" bun run setup)
jq -n --arg command "$repo/node_modules/.bin/typescript-language-server" --arg root "$root" \
  '{servers:[{extensions:["ts"],command:[$command,"--stdio"],rootDir:$root}]}' > "$root/cclsp.json"
mkdir -p "$root/src"
printf 'export {};\nconst a: string = foo(1);\nfunction foo(value: number) { return value; }\n' > "$root/src/a.ts"
printf 'export {};\nconst b: string = foo(2);\nfunction foo(value: number) { return value; }\n' > "$root/src/b.ts"
printf 'const j = foo(3, 4);\n' > "$root/a.js"
printf '<?php $p = foo(4);\n' > "$root/a.php"
printf '// @generated\nconst g = foo(5);\n' > "$root/generated.ts"
(
  cd "$root"
  git init -q
  git add .
  git -c user.name=cclsp -c user.email=cclsp@example.invalid commit -qm fixture
)
export XDG_RUNTIME_DIR="$runtime" CCLSP_HUB_CONFIG="$root/cclsp.json"
"$hub" ensure-root "$root" >/dev/null
"$hub" describe --json | jq -e '.tools[] | select(.name=="code_rewrite") | .inputSchema.required == ["pattern","replacement","language"]'
"$hub" help | grep -F 'code_rewrite'
"$hub" help | grep -F 'use rename_symbol_strict for semantic symbol renames'

"$hub" get_diagnostics --file "$root/src/a.ts" --json \
  | jq -e '[.content[].text] | join("\n") | contains("not assignable")'
preview="$runtime/preview.json"
"$hub" code-rewrite --root "$root" --language typescript --path src \
  --pattern 'foo($ARG)' --replacement 'String(foo($ARG))' --json > "$preview"
jq -e '.structuredContent | .outcome=="ok" and .dryRun==true and .changesPlanned==2 and .filesChanged==2' "$preview"
grep -F 'const a: string = foo(' "$root/src/a.ts" >/dev/null
candidate=$(jq -r '.structuredContent.candidateId' "$preview")
"$hub" code_rewrite --root "$root" --language typescript --path src \
  --pattern 'foo($ARG)' --replacement 'String(foo($ARG))' \
  --dry-run=false --candidate-id "$candidate" --json \
  | jq -e '.structuredContent | .outcome=="ok" and .dryRun==false and .changesApplied==2 and .rollback.attempted==false'
grep -F 'String(foo(1))' "$root/src/a.ts" >/dev/null
grep -F 'String(foo(2))' "$root/src/b.ts" >/dev/null
"$hub" ast_search --root "$root" --language typescript --path src/a.ts --pattern 'String(foo($ARG))' --json \
  | jq -e '.structuredContent | .outcome=="ok" and (.matches|length)==1'
"$hub" get_diagnostics --file "$root/src/a.ts" --json > "$runtime/post-rewrite-diagnostics.json"
jq -e '[.content[].text] | join("\n") | contains("not assignable") | not' "$runtime/post-rewrite-diagnostics.json" || {
  cat "$runtime/post-rewrite-diagnostics.json" >&2
  exit 1
}

"$hub" code_rewrite --root "$root" --language javascript --path a.js \
  --pattern 'foo($$$ARGS)' --replacement 'bar(0, $$$ARGS)' --json > "$runtime/javascript.json"
js_id=$(jq -r '.structuredContent.candidateId' "$runtime/javascript.json")
"$hub" code_rewrite --root "$root" --language javascript --path a.js \
  --pattern 'foo($$$ARGS)' --replacement 'bar(0, $$$ARGS)' --dry-run=false --candidate-id "$js_id" --json \
  | jq -e '.structuredContent | .outcome=="ok" and .changesApplied==1'
"$hub" code_rewrite --root "$root" --language php --path a.php \
  --pattern 'foo($ARG)' --replacement 'bar(0, $ARG)' --json > "$runtime/php.json"
php_id=$(jq -r '.structuredContent.candidateId' "$runtime/php.json")
"$hub" code_rewrite --root "$root" --language php --path a.php \
  --pattern 'foo($ARG)' --replacement 'bar(0, $ARG)' --dry-run=false --candidate-id "$php_id" --json \
  | jq -e '.structuredContent | .outcome=="ok" and .changesApplied==1'

expect_error(){
  local code=$1; shift
  local output="$runtime/error-$code-$RANDOM.json"
  if "$hub" "$@" --json > "$output"; then
    echo "expected $code failure" >&2
    exit 1
  fi
  jq -e --arg code "$code" '.structuredContent | (.outcome=="rejected" or .outcome=="failed") and .code==$code' "$output"
}
expect_error AST_REWRITE_PREVIEW_REQUIRED code_rewrite --root "$root" --language typescript --path src/a.ts --pattern 'String(foo($A))' --replacement 'wrap($A)' --dry-run=false
expect_error AST_REWRITE_CAPTURE_INVALID code_rewrite --root "$root" --language typescript --path src/a.ts --pattern 'String(foo($A))' --replacement 'wrap($MISSING)'
expect_error AST_REWRITE_TARGET_UNSAFE code_rewrite --root "$root" --language typescript --path generated.ts --pattern 'foo($A)' --replacement 'bar(0, $A)'
printf 'const dirty = foo(9);\n' > "$root/dirty.ts"
expect_error AST_REWRITE_TARGET_DIRTY code_rewrite --root "$root" --language typescript --path dirty.ts --pattern 'foo($A)' --replacement 'bar(0, $A)'

printf '{"servers":[]}' > "$stale_root/cclsp.json"
printf 'const s = foo(1);\n' > "$stale_root/s.ts"
"$hub" ensure-root "$stale_root" >/dev/null
expect_error AST_REWRITE_SEMANTIC_RENAME code_rewrite --root "$stale_root" --language typescript --path s.ts --pattern 'foo($A)' --replacement 'bar($A)'
expect_error AST_PATH_ESCAPED code_rewrite --root "$stale_root" --language typescript --path ../outside.ts --pattern 'foo($A)' --replacement 'bar(0, $A)'
expect_error AST_LANGUAGE_UNSUPPORTED code_rewrite --root "$stale_root" --language ruby --path s.ts --pattern 'foo($A)' --replacement 'bar(0, $A)'
expect_error AST_REWRITE_CONFLICT code_rewrite --root "$stale_root" --language typescript --path s.ts --pattern '$NODE' --replacement 'wrap(0, $NODE)'
expect_error AST_REWRITE_REPLACEMENT_INVALID code_rewrite --root "$stale_root" --language typescript --path s.ts --pattern 'foo($A)' --replacement 'bar('
"$hub" code_rewrite --root "$stale_root" --language typescript --path s.ts \
  --pattern 'foo($A)' --replacement 'bar(0, $A)' --json > "$runtime/stale-preview.json"
stale_id=$(jq -r '.structuredContent.candidateId' "$runtime/stale-preview.json")
printf 'const s = foo(2);\n' > "$stale_root/s.ts"
expect_error AST_REWRITE_STALE code_rewrite --root "$stale_root" --language typescript --path s.ts \
  --pattern 'foo($A)' --replacement 'bar(0, $A)' --dry-run=false --candidate-id "$stale_id"

# A separate isolated daemon injects a failure after the first rename. Exact hashes
# must be restored and the machine-readable rollback must be complete.
"$hub" shutdown >/dev/null
rm -rf "$runtime"; runtime=$(mktemp -d "${TMPDIR:-/tmp}/cclsp-rewrite-failure-XXXXXX")
export XDG_RUNTIME_DIR="$runtime" CCLSP_REWRITE_TEST_MODE=1 CCLSP_REWRITE_TEST_FAILURE='before-rename:1'
mkdir -p "$root/rollback"
printf 'const x = foo(1);\n' > "$root/rollback/x.ts"
printf 'const y = foo(2);\n' > "$root/rollback/y.ts"
(
  cd "$root"
  git add rollback/x.ts rollback/y.ts
  git -c user.name=cclsp -c user.email=cclsp@example.invalid commit -qm rollback-fixture
)
before_x=$(sha256sum "$root/rollback/x.ts" | cut -d' ' -f1)
before_y=$(sha256sum "$root/rollback/y.ts" | cut -d' ' -f1)
"$hub" ensure-root "$root" >/dev/null
"$hub" code_rewrite --root "$root" --language typescript --path rollback \
  --pattern 'foo($A)' --replacement 'bar(0, $A)' --json > "$runtime/rollback-preview.json"
rollback_id=$(jq -r '.structuredContent.candidateId' "$runtime/rollback-preview.json")
expect_error AST_REWRITE_TRANSACTION_FAILED code_rewrite --root "$root" --language typescript --path rollback \
  --pattern 'foo($A)' --replacement 'bar(0, $A)' --dry-run=false --candidate-id "$rollback_id"
[[ $(sha256sum "$root/rollback/x.ts" | cut -d' ' -f1) == "$before_x" ]]
[[ $(sha256sum "$root/rollback/y.ts" | cut -d' ' -f1) == "$before_y" ]]
find "$root" -name '*.cclsp-rewrite-*.tmp' -print -quit | grep -q . && exit 1 || true
"$hub" status | grep -F "$root"

# Fail after forward LSP synchronization, then prove disk, LSP diagnostics, and AST
# state all observe the restored originals.
"$hub" shutdown >/dev/null
rm -rf "$runtime"; runtime=$(mktemp -d "${TMPDIR:-/tmp}/cclsp-rewrite-sync-failure-XXXXXX")
export XDG_RUNTIME_DIR="$runtime" CCLSP_REWRITE_TEST_FAILURE='before-forward-invalidate'
"$hub" ensure-root "$root" >/dev/null
"$hub" get_diagnostics --file "$root/rollback/x.ts" --json \
  | jq -r '[.content[].text] | join("\n")' > "$runtime/diagnostics-before.txt"
"$hub" code_rewrite --root "$root" --language typescript --path rollback \
  --pattern 'foo($A)' --replacement 'bar(0, $A)' --json > "$runtime/sync-rollback-preview.json"
sync_rollback_id=$(jq -r '.structuredContent.candidateId' "$runtime/sync-rollback-preview.json")
expect_error AST_REWRITE_TRANSACTION_FAILED code_rewrite --root "$root" --language typescript --path rollback \
  --pattern 'foo($A)' --replacement 'bar(0, $A)' --dry-run=false --candidate-id "$sync_rollback_id"
[[ $(sha256sum "$root/rollback/x.ts" | cut -d' ' -f1) == "$before_x" ]]
[[ $(sha256sum "$root/rollback/y.ts" | cut -d' ' -f1) == "$before_y" ]]
"$hub" ast_search --root "$root" --language typescript --path rollback/x.ts --pattern 'foo($A)' --json \
  | jq -e '.structuredContent | .outcome=="ok" and (.matches|length)==1'
"$hub" get_diagnostics --file "$root/rollback/x.ts" --json \
  | jq -r '[.content[].text] | join("\n")' > "$runtime/diagnostics-after.txt"
cmp "$runtime/diagnostics-before.txt" "$runtime/diagnostics-after.txt"
find "$root" -name '*.cclsp-rewrite-*.tmp' -print -quit | grep -q . && exit 1 || true
"$hub" status | grep -F "$root"
echo 'installed structural rewrite scenario PASS'
