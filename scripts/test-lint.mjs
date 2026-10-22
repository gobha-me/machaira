import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { ESLint } from 'eslint'

const eslint = new ESLint()
const require = createRequire(import.meta.url)

async function messages(code, filePath = 'shared/src/index.ts') {
  const [result] = await eslint.lintText(code, { filePath })
  assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages))
  return result.messages
}

test('typed promise errors are rejected in every workspace, including Vue scripts and server/shared tests', async () => {
  for (const filePath of ['client/src/main.ts', 'server/src/index.ts', 'shared/src/index.ts', 'server/test/auth.test.ts', 'shared/test/scripture-reference.test.ts']) {
    const result = await messages('Promise.resolve(1)\n', filePath)
    assert.ok(result.some(({ ruleId, severity }) => ruleId === '@typescript-eslint/no-floating-promises' && severity === 2), filePath)
  }
  const result = await messages('<script setup lang="ts">\nPromise.resolve(1)\n</script>\n', 'client/src/App.vue')
  assert.ok(result.some(({ ruleId }) => ruleId === '@typescript-eslint/no-floating-promises'))
  assert.ok((await messages('await 1\n')).some(({ ruleId }) => ruleId === '@typescript-eslint/await-thenable'))
  assert.ok((await messages('const invoke = (callback: () => void) => callback()\ninvoke(async () => {})\n')).some(({ ruleId }) => ruleId === '@typescript-eslint/no-misused-promises'))
})

test('missing, blank, blanket, file-level, and same-line suppressions fail in scripts and templates', async () => {
  const invalid = [
    'eslint-disable-next-line no-debugger',
    'eslint-disable-next-line no-debugger --   ',
    'eslint-disable-next-line -- A reason without a rule',
    'eslint-disable no-debugger -- File-wide suppression',
    'eslint-disable-line no-debugger -- Same-line suppression'
  ]
  for (const directive of invalid) {
    for (const filePath of ['shared/src/index.ts', 'client/src/App.vue']) {
      const source = `/* ${directive} */\ndebugger\n`
      const result = await messages(filePath.endsWith('.vue') ? `<script setup lang="ts">\n${source}</script>\n` : source, filePath)
      assert.ok(result.some(({ ruleId }) => ruleId?.startsWith('eslint-comments/')), `${filePath}: ${directive}`)
    }
    const result = await messages(`<template>\n  <!-- ${directive} -->\n  <div />\n</template>\n`, 'client/src/App.vue')
    assert.ok(result.some(({ ruleId }) => ruleId === 'template-comments/specific-disable-with-reason'), directive)
  }
  for (const filePath of ['shared/src/index.ts', 'client/src/App.vue']) {
    const source = '// eslint-disable-next-line no-debugger -- Exercise a deliberate debugger fixture.\ndebugger\n'
    assert.deepEqual(await messages(filePath.endsWith('.vue') ? `<script setup lang="ts">\n${source}</script>\n` : source, filePath), [])
  }
  assert.deepEqual(await messages('<template>\n  <!-- eslint-disable-next-line vue/no-v-html -- The fixture deliberately exercises the rendering boundary. -->\n  <div v-html="\'safe\'" />\n</template>\n', 'client/src/App.vue'), [])
  assert.ok((await messages('// eslint-disable-next-line no-debugger -- Stale suppression.\nexport {}\n')).some(({ message }) => message.includes('Unused eslint-disable')))
})

test('Vue recommended and accessibility rules reject invalid markup and unlabeled controls', async () => {
  assert.ok((await messages('<template>\n  <button id="one" id="two">Bad</button>\n</template>\n', 'client/src/App.vue')).some(({ ruleId }) => ruleId === 'vue/no-duplicate-attributes'))
  assert.ok((await messages('<template>\n  <input type="text">\n</template>\n', 'client/src/App.vue')).some(({ ruleId }) => ruleId === 'vuejs-accessibility/form-control-has-label'))
})

test('the CLI exits nonzero for a lint error and for warnings alone', () => {
  const cli = join(dirname(require.resolve('eslint/package.json')), 'bin/eslint.js')
  for (const [filePath, source, expected] of [
    ['shared/src/index.ts', 'debugger\n', 'no-debugger'],
    ['client/src/App.vue', '<template>\n<div />\n</template>\n', 'vue/html-indent']
  ]) {
    const result = spawnSync(process.execPath, [cli, '--stdin', '--stdin-filename', filePath, '--max-warnings', '0'], { input: source, encoding: 'utf8' })
    assert.equal(result.status, 1, result.stderr)
    assert.ok(result.stdout.includes(expected), result.stdout)
    if (filePath.endsWith('.vue')) assert.match(result.stdout, /0 errors, \d+ warnings?/)
  }
})
