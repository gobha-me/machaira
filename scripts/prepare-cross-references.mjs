// Reproduce the bundled snapshot from a separately downloaded upstream ZIP:
// unzip -p cross-references.zip cross_references.txt > /tmp/cross-references.tsv
// node scripts/prepare-cross-references.mjs /tmp/cross-references.tsv
// Review the resulting metadata and upstream license before committing an update.
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

const input = readFileSync(process.argv[2], 'utf8')
const lines = input.trimEnd().split(/\r?\n/)
const snapshot = lines.shift()?.match(/^From Verse\tTo Verse\tVotes\t#www\.openbible\.info CC-BY (\d{4}-\d{2}-\d{2})$/)?.[1]
if (!snapshot || lines.some((line) => !/^[1-3]?[A-Za-z]+\.\d+\.\d+\t[1-3]?[A-Za-z]+\.\d+\.\d+(?:-[1-3]?[A-Za-z]+\.\d+\.\d+)?\t-?\d+$/.test(line))) {
  throw new Error('Unexpected upstream cross-reference format or attribution')
}
const data = gzipSync(input, { level: 9, mtime: 0 })
const base = new URL('../server/resources/', import.meta.url)
writeFileSync(new URL('openbible-cross-references.tsv.gz', base), data)
const metadataPath = new URL('openbible.json', base)
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
Object.assign(metadata, { snapshot, rows: lines.length, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n')
