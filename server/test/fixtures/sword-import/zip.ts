import { crc32 } from 'node:zlib'

export type ZipMember = readonly [path: string, contents: Buffer]

/** Build a small, uncompressed ZIP from the test's fixture entries. */
export function fixtureZip(members: readonly ZipMember[]): Buffer {
  const files: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0

  for (const [path, contents] of members) {
    const name = Buffer.from(path)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc32(contents), 14)
    local.writeUInt32LE(contents.length, 18)
    local.writeUInt32LE(contents.length, 22)
    local.writeUInt16LE(name.length, 26)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    // Version, flags, compression, timestamps, CRC, sizes and name length.
    local.copy(central, 6, 4, 28)
    central.writeUInt32LE(offset, 42)

    files.push(local, name, contents)
    directory.push(central, name)
    offset += local.length + name.length + contents.length
  }

  const index = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(members.length, 8)
  end.writeUInt16LE(members.length, 10)
  end.writeUInt32LE(index.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...files, index, end])
}
