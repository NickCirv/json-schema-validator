<div align="center">

# json-schema-validator

**Validate JSON files against a draft-7 schema — zero dependencies, from the terminal.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue?labelColor=0B0A09)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?labelColor=0B0A09)](package.json)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-339933?labelColor=0B0A09&logo=node.js&logoColor=white)](package.json)

</div>

## Install

```bash
npx github:NickCirv/json-schema-validator schema.json data.json
```

Or install globally for the `jsv` shorthand:

```bash
npm install -g github:NickCirv/json-schema-validator
```

## Usage

```bash
jsv schema.json data.json              # validate a single file
jsv schema.json ./fixtures/            # validate every .json in a directory
jsv schema.json *.json --errors-only   # CI — print failures only
jsv schema.json data.json --watch      # re-validate on file changes
```

| Flag | Description |
|------|-------------|
| `--watch` | Re-validate on file changes |
| `--json` | Output results as JSON (CI-friendly) |
| `--coerce` | Attempt type coercion before failing (`"42"` → `42`) |
| `--errors-only` | Suppress output for valid files |

**Exit codes:** `0` all valid · `1` validation errors · `2` schema/parse error

## What it does

Runs JSON Schema draft-7 validation entirely in pure Node.js — no Ajv, no ajv-formats, no install overhead. Supports the full keyword set: `allOf` / `anyOf` / `oneOf` / `not` / `if-then-else`, `$ref` (local `$defs` and `definitions`), format validators (`email`, `uuid`, `date-time`, `uri`, `ipv4`, `ipv6`, `hostname`), and more. Watch mode rerenders results live on each file change, making it practical during active schema development.

---
<sub>Zero dependencies · Node ≥ 18 · MIT · by <a href="https://github.com/NickCirv">NickCirv</a></sub>
