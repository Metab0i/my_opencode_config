#!/usr/bin/env node
/**
 * verifyjson.mjs — Verify a JSON string is well-formed and prettify it.
 *
 * This is the verify-json skill. There is no SKILL.md: this script is the
 * entire skill — agents run it directly.
 *
 * Usage:
 *   node verifyjson.mjs <file>       # verify a JSON file
 *   ... | node verifyjson.mjs        # verify JSON from stdin
 *   node verifyjson.mjs '<json>'     # verify a JSON string argument
 *
 * If an argument is given it wins over stdin: it is treated as a file path if
 * a file exists at that path, otherwise as an inline JSON string.
 *
 * Output:
 *   Valid   → "verifyjson: valid JSON" followed by the prettified JSON,
 *             2-space indented, keys in original order.
 *   Invalid → "verifyjson: INVALID JSON" (with line/column when the parser
 *             reports a position) followed by the parse error, on stderr.
 *   Usage   → "verifyjson: <problem>" + usage line, on stderr.
 *
 * Exit codes: 0 valid, 1 invalid, 2 usage error.
 *
 * Guarantees: only verifies and formats; never fixes or mutates the JSON's
 * content.
 */
import { readFileSync } from "node:fs";

/** @returns {string} the raw input text */
function readInput() {
  if (process.argv.length > 3) {
    usageError("too many arguments — pass a file path, a JSON string, or nothing (stdin)");
  }
  const arg = process.argv[2];
  if (arg !== undefined) {
    // Argument wins over stdin: agents may run this with a piped stdin that
    // they don't intend as input.
    try {
      // Argument is a file path if it resolves to an existing file; otherwise
      // treat it as an inline JSON string.
      return readFileSync(arg, "utf8");
    } catch {
      return arg;
    }
  }
  if (process.stdin.isTTY) {
    usageError("no input — pass a file path, a JSON string, or pipe JSON via stdin");
  }
  return readFileSync(0, "utf8");
}

function usageError(message) {
  process.stderr.write(`verifyjson: ${message}\nusage: node verifyjson.mjs [<file> | '<json>']\n`);
  process.exit(2);
}

/** @returns {{line: number, column: number}} 1-indexed position in the input */
function locate(text, index) {
  const upto = text.slice(0, index);
  const lines = upto.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

const input = readInput();

let parsed;
try {
  parsed = JSON.parse(input);
} catch (err) {
  const position = typeof err.message === "string" ? (/\bposition (\d+)/.exec(err.message)?.[1] ?? null) : null;
  let location = "";
  if (position !== null) {
    const { line, column } = locate(input, Number(position));
    location = ` (line ${line}, column ${column})`;
  }
  process.stderr.write(`verifyjson: INVALID JSON${location}\n${err.message}\n`);
  process.exit(1);
}

process.stdout.write(`verifyjson: valid JSON\n${JSON.stringify(parsed, null, 2)}\n`);
