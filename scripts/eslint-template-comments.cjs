// eslint-comments handles script comments; vue-eslint-parser keeps HTML comments
// separately, so enforce the same suppression policy at the template boundary.
module.exports = {
  rules: {
    'specific-disable-with-reason': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          invalid: 'Use only eslint-disable-next-line <rule> -- <reason> in template comments.'
        }
      },
      create(context) {
        return {
          Program() {
            const fragment = context.sourceCode.parserServices.getDocumentFragment?.()
            for (const comment of fragment?.comments ?? []) {
              const value = comment.value.trim()
              if (!/^eslint(?:\s|$|-)/u.test(value)) continue
              if (!/^eslint-disable-next-line\s+[\w@/-]+(?:\s*,\s*[\w@/-]+)*\s+--\s+\S[^\r\n]*$/u.test(value)) {
                // Report before column zero so a blanket template disable cannot hide this rule.
                context.report({ loc: { start: { line: comment.loc.start.line, column: -1 }, end: comment.loc.end }, messageId: 'invalid' })
              }
            }
          }
        }
      }
    }
  }
}
