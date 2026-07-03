#!/usr/bin/env node
import { run } from "../lib/cli.mjs";

const code = await run(process.argv.slice(2));
process.exit(code);
