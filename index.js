#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawnSync } from 'child_process';

// ─── ANSI Colors ────────────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const c = {
  green:  s => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:    s => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: s => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  bold:   s => isTTY ? `\x1b[1m${s}\x1b[0m`  : s,
  dim:    s => isTTY ? `\x1b[2m${s}\x1b[0m`  : s,
};

// ─── Format Validators (regex-based, no external deps) ───────────────────────
const FORMAT_VALIDATORS = {
  email:     v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  uri:       v => /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\/[^\s]+$/.test(v),
  date:      v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)),
  'date-time': v => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v),
  uuid:      v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  ipv4:      v => /^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every(n => +n <= 255),
  ipv6:      v => /^[0-9a-fA-F:]+$/.test(v) && v.includes(':'),
  hostname:  v => /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/.test(v),
};

// ─── Type Coercion ───────────────────────────────────────────────────────────
function coerce(value, schema) {
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) {
      const n = Number(value);
      return schema.type === 'integer' ? (Number.isInteger(n) ? n : value) : n;
    }
  }
  if (schema.type === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  if (schema.type === 'string' && typeof value !== 'string') {
    return String(value);
  }
  return value;
}

// ─── JSON Schema Validator ────────────────────────────────────────────────────
class Validator {
  constructor(rootSchema, opts = {}) {
    this.root = rootSchema;
    this.opts = opts;
    this.errors = [];
  }

  validate(data, schema = this.root, path = 'data', defs = null) {
    if (defs === null) {
      defs = { ...(this.root.$defs || {}), ...(this.root.definitions || {}) };
    }

    // Resolve $ref
    if (schema && schema.$ref) {
      const ref = schema.$ref;
      if (ref.startsWith('#/$defs/')) {
        const key = ref.slice(8);
        if (defs[key]) return this.validate(data, defs[key], path, defs);
        this.errors.push({ path, message: `Unknown $ref: ${ref}` });
        return;
      }
      if (ref.startsWith('#/definitions/')) {
        const key = ref.slice(14);
        if (defs[key]) return this.validate(data, defs[key], path, defs);
        this.errors.push({ path, message: `Unknown $ref: ${ref}` });
        return;
      }
      if (ref === '#') {
        return this.validate(data, this.root, path, defs);
      }
      this.errors.push({ path, message: `External $ref not supported: ${ref}` });
      return;
    }

    if (schema === true) return;
    if (schema === false) {
      this.errors.push({ path, message: 'Schema is false — no values are valid' });
      return;
    }
    if (!schema || typeof schema !== 'object') return;

    // Coerce if requested
    if (this.opts.coerce && schema.type) {
      data = coerce(data, schema);
    }

    // enum
    if (schema.enum !== undefined) {
      const match = schema.enum.some(e => deepEqual(e, data));
      if (!match) {
        this.errors.push({ path, message: `must be one of: ${JSON.stringify(schema.enum)}` });
      }
    }

    // const
    if (schema.const !== undefined) {
      if (!deepEqual(schema.const, data)) {
        this.errors.push({ path, message: `must equal: ${JSON.stringify(schema.const)}` });
      }
    }

    // type
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some(t => checkType(t, data))) {
        this.errors.push({ path, message: `must be of type ${types.join(' or ')} (got ${getType(data)})` });
        return; // don't validate further if type is wrong
      }
    }

    const type = getType(data);

    // String validations
    if (type === 'string') {
      if (schema.minLength !== undefined && data.length < schema.minLength) {
        this.errors.push({ path, message: `must be at least ${schema.minLength} character(s)` });
      }
      if (schema.maxLength !== undefined && data.length > schema.maxLength) {
        this.errors.push({ path, message: `must be at most ${schema.maxLength} character(s)` });
      }
      if (schema.pattern !== undefined) {
        try {
          if (!new RegExp(schema.pattern).test(data)) {
            this.errors.push({ path, message: `must match pattern: ${schema.pattern}` });
          }
        } catch {
          this.errors.push({ path, message: `invalid pattern: ${schema.pattern}` });
        }
      }
      if (schema.format !== undefined) {
        const fn = FORMAT_VALIDATORS[schema.format];
        if (fn && !fn(data)) {
          this.errors.push({ path, message: `must be a valid ${schema.format} format` });
        }
      }
    }

    // Number / integer validations
    if (type === 'number' || type === 'integer') {
      if (schema.minimum !== undefined && data < schema.minimum) {
        this.errors.push({ path, message: `must be >= ${schema.minimum}` });
      }
      if (schema.maximum !== undefined && data > schema.maximum) {
        this.errors.push({ path, message: `must be <= ${schema.maximum}` });
      }
      if (schema.exclusiveMinimum !== undefined) {
        if (typeof schema.exclusiveMinimum === 'number' && data <= schema.exclusiveMinimum) {
          this.errors.push({ path, message: `must be > ${schema.exclusiveMinimum}` });
        } else if (schema.exclusiveMinimum === true && schema.minimum !== undefined && data <= schema.minimum) {
          this.errors.push({ path, message: `must be > ${schema.minimum} (exclusive)` });
        }
      }
      if (schema.exclusiveMaximum !== undefined) {
        if (typeof schema.exclusiveMaximum === 'number' && data >= schema.exclusiveMaximum) {
          this.errors.push({ path, message: `must be < ${schema.exclusiveMaximum}` });
        } else if (schema.exclusiveMaximum === true && schema.maximum !== undefined && data >= schema.maximum) {
          this.errors.push({ path, message: `must be < ${schema.maximum} (exclusive)` });
        }
      }
      if (schema.multipleOf !== undefined && data % schema.multipleOf !== 0) {
        this.errors.push({ path, message: `must be a multiple of ${schema.multipleOf}` });
      }
    }

    // Array validations
    if (type === 'array') {
      if (schema.minItems !== undefined && data.length < schema.minItems) {
        this.errors.push({ path, message: `must have at least ${schema.minItems} item(s)` });
      }
      if (schema.maxItems !== undefined && data.length > schema.maxItems) {
        this.errors.push({ path, message: `must have at most ${schema.maxItems} item(s)` });
      }
      if (schema.uniqueItems) {
        const seen = [];
        for (const item of data) {
          if (seen.some(s => deepEqual(s, item))) {
            this.errors.push({ path, message: 'items must be unique' });
            break;
          }
          seen.push(item);
        }
      }
      if (schema.items !== undefined) {
        if (Array.isArray(schema.items)) {
          for (let i = 0; i < schema.items.length; i++) {
            if (i < data.length) {
              this.validate(data[i], schema.items[i], `${path}[${i}]`, defs);
            }
          }
          if (schema.additionalItems === false && data.length > schema.items.length) {
            this.errors.push({ path, message: `must not have more than ${schema.items.length} item(s)` });
          } else if (schema.additionalItems && typeof schema.additionalItems === 'object') {
            for (let i = schema.items.length; i < data.length; i++) {
              this.validate(data[i], schema.additionalItems, `${path}[${i}]`, defs);
            }
          }
        } else {
          for (let i = 0; i < data.length; i++) {
            this.validate(data[i], schema.items, `${path}[${i}]`, defs);
          }
        }
      }
      if (schema.contains !== undefined) {
        const found = data.some(item => {
          const v = new Validator(this.root, this.opts);
          v.validate(item, schema.contains, path, defs);
          return v.errors.length === 0;
        });
        if (!found) {
          this.errors.push({ path, message: 'must contain at least one item matching the "contains" schema' });
        }
      }
    }

    // Object validations
    if (type === 'object') {
      const keys = Object.keys(data);

      if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
        this.errors.push({ path, message: `must have at least ${schema.minProperties} propert${schema.minProperties === 1 ? 'y' : 'ies'}` });
      }
      if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
        this.errors.push({ path, message: `must have at most ${schema.maxProperties} propert${schema.maxProperties === 1 ? 'y' : 'ies'}` });
      }

      // required
      if (schema.required) {
        for (const req of schema.required) {
          if (!(req in data)) {
            this.errors.push({ path, message: `missing required property: "${req}"` });
          }
        }
      }

      // properties
      const knownProps = new Set();
      if (schema.properties) {
        for (const [key, subSchema] of Object.entries(schema.properties)) {
          knownProps.add(key);
          if (key in data) {
            this.validate(data[key], subSchema, `${path}.${key}`, defs);
          }
        }
      }

      // patternProperties
      if (schema.patternProperties) {
        for (const [pattern, subSchema] of Object.entries(schema.patternProperties)) {
          try {
            const re = new RegExp(pattern);
            for (const key of keys) {
              if (re.test(key)) {
                knownProps.add(key);
                this.validate(data[key], subSchema, `${path}.${key}`, defs);
              }
            }
          } catch {
            this.errors.push({ path, message: `invalid patternProperties pattern: ${pattern}` });
          }
        }
      }

      // additionalProperties
      if (schema.additionalProperties !== undefined) {
        const extraKeys = keys.filter(k => !knownProps.has(k));
        if (schema.additionalProperties === false) {
          for (const key of extraKeys) {
            this.errors.push({ path: `${path}.${key}`, message: 'additional property not allowed' });
          }
        } else if (typeof schema.additionalProperties === 'object') {
          for (const key of extraKeys) {
            this.validate(data[key], schema.additionalProperties, `${path}.${key}`, defs);
          }
        }
      }

      // dependencies
      if (schema.dependencies) {
        for (const [key, dep] of Object.entries(schema.dependencies)) {
          if (key in data) {
            if (Array.isArray(dep)) {
              for (const req of dep) {
                if (!(req in data)) {
                  this.errors.push({ path, message: `property "${req}" is required when "${key}" is present` });
                }
              }
            } else {
              this.validate(data, dep, path, defs);
            }
          }
        }
      }
    }

    // Combining schemas
    if (schema.allOf) {
      for (let i = 0; i < schema.allOf.length; i++) {
        this.validate(data, schema.allOf[i], path, defs);
      }
    }

    if (schema.anyOf) {
      const valid = schema.anyOf.some(sub => {
        const v = new Validator(this.root, this.opts);
        v.validate(data, sub, path, defs);
        return v.errors.length === 0;
      });
      if (!valid) {
        this.errors.push({ path, message: 'must match at least one schema in "anyOf"' });
      }
    }

    if (schema.oneOf) {
      const matches = schema.oneOf.filter(sub => {
        const v = new Validator(this.root, this.opts);
        v.validate(data, sub, path, defs);
        return v.errors.length === 0;
      });
      if (matches.length !== 1) {
        this.errors.push({ path, message: `must match exactly one schema in "oneOf" (matched ${matches.length})` });
      }
    }

    if (schema.not) {
      const v = new Validator(this.root, this.opts);
      v.validate(data, schema.not, path, defs);
      if (v.errors.length === 0) {
        this.errors.push({ path, message: 'must not match the "not" schema' });
      }
    }

    // if / then / else
    if (schema.if !== undefined) {
      const condV = new Validator(this.root, this.opts);
      condV.validate(data, schema.if, path, defs);
      if (condV.errors.length === 0) {
        if (schema.then !== undefined) {
          this.validate(data, schema.then, path, defs);
        }
      } else {
        if (schema.else !== undefined) {
          this.validate(data, schema.else, path, defs);
        }
      }
    }
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────
function getType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function checkType(type, v) {
  if (type === 'integer') return typeof v === 'number' && Number.isInteger(v);
  if (type === 'number')  return typeof v === 'number';
  if (type === 'null')    return v === null;
  if (type === 'array')   return Array.isArray(v);
  if (type === 'object')  return typeof v === 'object' && v !== null && !Array.isArray(v);
  return typeof v === type;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

function loadJSON(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function expandGlobs(patterns) {
  const files = [];
  for (const pat of patterns) {
    if (pat.includes('*')) {
      const dir = path.dirname(pat);
      const base = path.basename(pat).replace(/\*/g, '.*');
      const re = new RegExp(`^${base}$`);
      try {
        const entries = fs.readdirSync(dir || '.');
        for (const e of entries) {
          if (re.test(e) && fs.statSync(path.join(dir || '.', e)).isFile()) {
            files.push(path.join(dir || '.', e));
          }
        }
      } catch { /* skip */ }
    } else {
      files.push(pat);
    }
  }
  return files;
}

function collectJsonFiles(target) {
  let stat;
  try { stat = fs.statSync(target); } catch { return [target]; }
  if (stat.isDirectory()) {
    return fs.readdirSync(target)
      .filter(f => f.endsWith('.json'))
      .map(f => path.join(target, f));
  }
  return [target];
}

// ─── Validation runner ───────────────────────────────────────────────────────
function validateFile(schemaPath, dataPath, opts) {
  let schema, data;
  try {
    schema = loadJSON(schemaPath);
  } catch (e) {
    return { file: dataPath, status: 'schema-error', message: `Schema parse error: ${e.message}` };
  }
  try {
    data = loadJSON(dataPath);
  } catch (e) {
    return { file: dataPath, status: 'parse-error', message: `JSON parse error: ${e.message}` };
  }

  const v = new Validator(schema, opts);
  v.validate(data);
  return {
    file: dataPath,
    status: v.errors.length === 0 ? 'valid' : 'invalid',
    errors: v.errors,
  };
}

function printResult(result, opts) {
  if (opts.json) return; // handled later
  const rel = result.file;
  if (result.status === 'valid') {
    if (!opts.errorsOnly) {
      console.log(c.green('✓') + ' ' + c.bold(rel) + c.dim(' — valid'));
    }
  } else if (result.status === 'invalid') {
    console.log(c.red('✗') + ' ' + c.bold(rel) + c.dim(` — ${result.errors.length} error(s)`));
    for (const err of result.errors) {
      console.log(`  ${c.dim(err.path + ':')} ${c.red(err.message)}`);
    }
  } else {
    console.log(c.yellow('⚠') + ' ' + c.bold(rel) + ' — ' + c.yellow(result.message));
  }
}

// ─── Watch mode ──────────────────────────────────────────────────────────────
function watchFiles(schemaPath, dataFiles, opts) {
  console.log(c.dim(`Watching ${dataFiles.length} file(s) and schema for changes... (Ctrl-C to stop)\n`));

  const runAll = () => {
    console.clear();
    console.log(c.bold('json-schema-validator') + c.dim(' — watch mode\n'));
    const results = dataFiles.map(f => validateFile(schemaPath, f, opts));
    results.forEach(r => printResult(r, opts));
    const invalid = results.filter(r => r.status !== 'valid').length;
    console.log(c.dim(`\n${results.length} file(s) — ${results.length - invalid} valid, ${invalid} invalid`));
  };

  runAll();

  const allFiles = [schemaPath, ...dataFiles];
  for (const f of allFiles) {
    try {
      fs.watch(f, () => runAll());
    } catch { /* skip */ }
  }
}

// ─── Help ────────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
${c.bold('json-schema-validator')} — CLI JSON Schema validator (draft-7, pure JS)

${c.bold('USAGE')}
  jsv <schema.json> <data.json>          Validate a single file
  jsv <schema.json> <dir/>               Validate all .json files in directory
  jsv <schema.json> *.json               Glob support
  jsv <schema.json> a.json b.json        Multiple files

${c.bold('OPTIONS')}
  --watch        Re-validate on file changes
  --json         Output results as JSON (for CI/pipelines)
  --coerce       Attempt type coercion (e.g. "42" → 42)
  --errors-only  Suppress output for valid files
  --help         Show this help

${c.bold('EXIT CODES')}
  0   All files valid
  1   One or more validation errors
  2   Schema or JSON parse error

${c.bold('EXAMPLES')}
  jsv schema.json data.json
  jsv schema.json ./fixtures/
  jsv schema.json *.json --errors-only
  jsv schema.json data.json --json
  jsv schema.json data.json --coerce --watch
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const opts = {
    watch:      args.includes('--watch'),
    json:       args.includes('--json'),
    coerce:     args.includes('--coerce'),
    errorsOnly: args.includes('--errors-only'),
  };

  const positional = args.filter(a => !a.startsWith('--'));
  if (positional.length < 2) {
    console.error(c.red('Error: provide a schema file and at least one data file or directory'));
    process.exit(2);
  }

  const schemaPath = positional[0];
  if (!fs.existsSync(schemaPath)) {
    console.error(c.red(`Error: schema file not found: ${schemaPath}`));
    process.exit(2);
  }

  const rawTargets = positional.slice(1);
  const expanded = expandGlobs(rawTargets);
  const dataFiles = expanded.flatMap(t => collectJsonFiles(t));

  if (dataFiles.length === 0) {
    console.error(c.yellow('Warning: no data files found'));
    process.exit(0);
  }

  if (opts.watch) {
    watchFiles(schemaPath, dataFiles, opts);
    return;
  }

  const results = dataFiles.map(f => validateFile(schemaPath, f, opts));
  results.forEach(r => printResult(r, opts));

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
  }

  const hasParseError  = results.some(r => r.status === 'schema-error' || r.status === 'parse-error');
  const hasInvalid     = results.some(r => r.status === 'invalid');

  if (hasParseError)  process.exit(2);
  if (hasInvalid)     process.exit(1);
  process.exit(0);
}

main();
