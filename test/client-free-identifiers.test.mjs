import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { CLIENT_PATH } from '../scripts/build-client.mjs'

// Bind the same single script the host loads. This is a name-resolution check, not a
// migration to TypeScript: old JS type diagnostics aren't part of this gate.
// Note: gate the generated entry — .agents/notes/implemented/2026-11-23-release-verification-gate.md
const unknownNames = new Set(Object.values(ts.Diagnostics)
  .filter((diagnostic) => diagnostic.key.startsWith('Cannot_find_name_0_'))
  .map((diagnostic) => diagnostic.code))
const options = { allowJs: true, checkJs: true, noEmit: true, types: [], target: ts.ScriptTarget.ES2024 }

function unresolvedNames(source) {
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, target, ...rest) => resolve(name) === CLIENT_PATH
    ? ts.createSourceFile(name, source, target, true)
    : getSourceFile(name, target, ...rest)
  const program = ts.createProgram([CLIENT_PATH], options, host)
  return program.getSemanticDiagnostics(program.getSourceFile(CLIENT_PATH))
    .filter(({ code }) => unknownNames.has(code))
    .map(({ file, start, messageText }) => {
      const { line, character } = file.getLineAndCharacterOfPosition(start)
      return `lib/client.js:${line + 1}:${character + 1}: ${ts.flattenDiagnosticMessageText(messageText, '\n')}`
    })
}

const source = readFileSync(CLIENT_PATH, 'utf8')
test('the shipped client has no unresolved browser-side identifiers', () => {
  assert.deepEqual(unresolvedNames(source), [])
})

test('the identifier gate catches unresolved names inside a deferred event callback', () => {
  const invalidCallback = '\nwindow.addEventListener("click", () => missingClientEventCallbackForTest());\n'
  assert.match(unresolvedNames(source + invalidCallback).join('\n'), /missingClientEventCallbackForTest/)
})
