import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import NodeSwordInterface from 'node-sword-interface'

const DEFAULT_TARGETS = [
  'CrossWire:KJVA', 'CrossWire:DRC', 'CrossWire:Enoch', 'CrossWire:Jubilees',
  'eBible.org:engwebbe2025eb', 'eBible.org:engLXX2012eb', 'eBible.org:engUKLXX2012eb'
]
const requested = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS
const home = await mkdtemp(join(tmpdir(), 'machaira-catalog-audit-'))
const nsi = new NodeSwordInterface(home)

try {
  const refresh = await nsi.updateRepositoryConfig()
  const output = []
  for (const identity of requested) {
    const separator = identity.lastIndexOf(':')
    const repository = identity.slice(0, separator)
    const name = identity.slice(separator + 1)
    const candidates = ['BIBLE', 'GENBOOK'].flatMap((type) =>
      nsi.getAllRepoModules(repository, type).map((module) => ({ ...module, type })))
    const module = candidates.find((candidate) => candidate.name === name)
    if (!module) {
      console.warn(`Skipping unavailable ${identity}`)
      continue
    }
    await nsi.installModule(repository, name)
    nsi.refreshLocalModules()
    const books = module.type === 'BIBLE' ? nsi.getBookList(name) : []
    output.push({ repository, name, version: module.version || '', type: module.type, license: module.distributionLicense || '', books })
  }
  const target = resolve('catalog-audit-output.json')
  await writeFile(target, `${JSON.stringify({ auditedAt: new Date().toISOString(), refresh, modules: output }, null, 2)}\n`, { flag: 'w' })
  console.log(`Wrote ${output.length} live module audits to ${target}`)
} finally {
  await rm(home, { recursive: true, force: true })
}
