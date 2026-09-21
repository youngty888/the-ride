#!/usr/bin/env node
/* Runs every test file in tests/. `node --test tests/` does not accept a folder on every
   Node version, so this lists the files itself. Usage: npm test  (or: node scripts/test.js) */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'tests');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.cjs')).sort().map(f => path.join(dir, f));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
