#!/usr/bin/env node
import { runAsync } from '../src/cli.js';

process.exitCode = await runAsync(process.argv.slice(2));
