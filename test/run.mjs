/**
 * Single entry point for `npm test`.
 *
 * The Node CLI test-runner's file discovery is not portable: `--test <dir>`
 * broke in v21+ (a directory argument is matched as a literal glob and then
 * executed as a file), and `--test-isolation=none` only exists in the versions
 * where the isolation flag was already stabilised. Importing the suites here
 * runs them in one process through node:test, which works on every supported
 * Node version, on every shell, and reports a non-zero exit code on failure.
 *
 * Adding a suite means adding one import line.
 */

import './session.test.mjs'
import './proxy.test.mjs'
