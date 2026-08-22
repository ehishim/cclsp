#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo"
runtime=$(mktemp -d "${TMPDIR:-/tmp}/cclsp-ast-runtime-XXXXXX")
root=$(mktemp -d "${TMPDIR:-/tmp}/cclsp-ast-root-XXXXXX")
bin=$(mktemp -d "${TMPDIR:-/tmp}/cclsp-ast-bin-XXXXXX")
outside=""
hub="$bin/cclsp-hub"
cleanup(){
  env XDG_RUNTIME_DIR="$runtime" CCLSP_HUB_CONFIG="$root/cclsp.json" "$hub" shutdown >/dev/null 2>&1 || true
  rm -rf "$runtime" "$root" "$bin"
  if [[ -n "$outside" ]]; then rm -rf "$outside"; fi
}
trap cleanup EXIT

(cd hub && CCLSP_HUB_BIN_DIR="$bin" bun run setup)
printf '{"servers":[]}' > "$root/cclsp.json"
printf 'function alpha(a: number) { return a; }\nfunction beta() {}\n' > "$root/sample.ts"
printf 'const view = <div />;\n' > "$root/sample.tsx"
printf 'function jsf() {}\n' > "$root/sample.js"
printf 'const jsxv = <span />;\n' > "$root/sample.jsx"
printf 'def pyf():\n    pass\n' > "$root/sample.py"
printf '<?php function phpf() {}\n' > "$root/sample.php"
printf 'package p\nfunc gof() {}\n' > "$root/sample.go"
printf 'fn rustf() {}\n' > "$root/sample.rs"
printf 'class Sample {}\n' > "$root/Sample.java"
export XDG_RUNTIME_DIR="$runtime" CCLSP_HUB_CONFIG="$root/cclsp.json"

if "$hub" ast_search --root "$root" --language typescript --pattern '$NAME' > "$root/unregistered.txt" 2>&1; then
  echo 'unregistered root unexpectedly succeeded' >&2
  exit 1
fi
grep -F 'root not registered' "$root/unregistered.txt"
"$hub" ensure-root "$root"
"$hub" describe --json | jq -e '.tools[] | select(.name=="ast_search") | .inputSchema.required == ["pattern","language"]'

"$hub" ast-search --root "$root" --language typescript --path sample.ts --pattern 'function $NAME($$$ARGS) { $$$BODY }' --json > "$root/concurrent-a.json" &
pid_a=$!
"$hub" ast_search --root "$root" --language typescript --path sample.ts --pattern 'function $NAME($$$ARGS) { $$$BODY }' --json > "$root/concurrent-b.json" &
pid_b=$!
wait "$pid_a" "$pid_b"
for output in "$root/concurrent-a.json" "$root/concurrent-b.json"; do
  jq -e '.structuredContent | .outcome=="ok" and .provider=="tree-sitter" and (.matches|length)==2' "$output"
done

run_search(){
  local language=$1 path=$2 pattern=$3 expected=$4
  "$hub" ast_search --root "$root" --language "$language" --path "$path" --pattern "$pattern" --json \
    | jq -e --arg expected "$expected" '.structuredContent | .outcome=="ok" and .provider=="tree-sitter" and (.matches|length)>0 and ([.matches[].text] | join("\n") | contains($expected))'
}
run_search tsx sample.tsx 'const $NAME = $VALUE' '<div />'
run_search javascript sample.js 'function $NAME($$$ARGS) { $$$BODY }' 'jsf'
run_search jsx sample.jsx 'const $NAME = $VALUE' '<span />'
run_search python sample.py $'def pyf():\n    pass' 'pyf'
run_search php sample.php 'function phpf() {}' 'phpf'
run_search go sample.go 'func gof() {}' 'gof'
run_search rust sample.rs 'fn rustf() {}' 'rustf'
run_search java Sample.java 'class Sample {}' 'Sample'

"$hub" get_document_symbols --file "$root/sample.php" --json \
  | jq -e '.structuredContent | .outcome=="ok" and .provider=="tree-sitter" and .symbols[0].name=="phpf"'
"$hub" find_definition --file "$root/sample.ts" --symbol-name alpha --json \
  | jq -e '.structuredContent | .outcome=="ok" and .provider=="tree-sitter" and (.locations|length)==1'

printf 'function edited() {}\n' > "$root/sample.ts"
run_search typescript sample.ts 'function $NAME($$$ARGS) { $$$BODY }' 'edited'
printf 'function added() {}\n' > "$root/added.ts"
run_search typescript . 'function $NAME($$$ARGS) { $$$BODY }' 'added'
mv "$root/added.ts" "$root/renamed.ts"
"$hub" ast_search --root "$root" --language typescript --pattern 'function $NAME($$$ARGS) { $$$BODY }' --json \
  | jq -e '.structuredContent | .outcome=="ok" and any(.matches[].file; endswith("/renamed.ts"))'
rm "$root/renamed.ts"
if "$hub" ast_search --root "$root" --language typescript --pattern 'function $NAME($$$ARGS) { $$$BODY }' --json | jq -e '.structuredContent.matches[].text | contains("renamed")' >/dev/null; then
  echo 'deleted file remained indexed' >&2
  exit 1
fi

"$hub" ast_search --root "$root" --language typescript --path sample.ts --pattern 'function $NAME($$$ARGS) { $$$BODY }' --max-results 1 --json \
  | jq -e '.structuredContent | .outcome=="ok" and .effectiveMaxResults==1 and .truncated==false and (.matches|length)==1'
"$hub" ast_search --root "$root" --language typescript --path sample.ts --pattern 'class Never {}' --json \
  | jq -e '.structuredContent | .outcome=="ok" and .provider=="tree-sitter" and .matches==[]'
printf 'const = ;\n' > "$root/broken.ts"
python3 - "$root/large.ts" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_bytes(b'x' * (512 * 1024 + 1))
PY
outside=$(mktemp -d "${TMPDIR:-/tmp}/cclsp-ast-outside-XXXXXX")
printf 'const escaped = 1;\n' > "$outside/escaped.ts"
ln -s "$outside/escaped.ts" "$root/escape.ts"
expect_error(){
  local code=$1; shift
  local output="$root/error-$code.json"
  if "$hub" "$@" --json > "$output"; then
    echo "expected $code failure" >&2
    exit 1
  fi
  jq -e --arg code "$code" '.structuredContent | .outcome=="rejected" and .code==$code' "$output"
}
expect_error AST_PATTERN_INVALID ast_search --root "$root" --language typescript --pattern 'function {'
expect_error AST_LANGUAGE_UNSUPPORTED ast_search --root "$root" --language ruby --pattern x
expect_error AST_FILE_OVERSIZED ast_search --root "$root" --language typescript --path large.ts --pattern '$NAME'
expect_error AST_PARSE_FAILED ast_search --root "$root" --language typescript --path broken.ts --pattern 'const $NAME = $VALUE'
expect_error AST_PATH_INVALID ast_search --root "$root" --language typescript --path missing.ts --pattern '$NAME'
expect_error AST_PATH_ESCAPED ast_search --root "$root" --language typescript --path escape.ts --pattern '$NAME'
rm -rf "$outside"

"$hub" restart-root "$root"
run_search typescript sample.ts 'function $NAME($$$ARGS) { $$$BODY }' 'edited'
"$hub" status | grep -F "$root"
echo 'installed AST scenario PASS'
