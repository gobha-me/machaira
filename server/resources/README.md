# Offline cross-reference data

Bible Cross References by [OpenBible.info](https://www.openbible.info/labs/cross-references/),
licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
The upstream page links this license; the TSV header retains its original CC-BY attribution.

Snapshot: 2026-10-19, 344,799 directed links including signed vote totals and target ranges.
`openbible-cross-references.tsv.gz` is the original TSV recompressed with gzip, 1,965,813 bytes
(1.87 MiB). No reference or vote changes. `openbible.json` records provenance and SHA-256.
No Bible translation text is included. The dataset retains its CC BY license separately
from the app's GPL-2.0-or-later code.

To update, download <https://a.openbible.info/data/cross-references.zip>, extract
`cross_references.txt`, then run `node scripts/prepare-cross-references.mjs /path/to/cross_references.txt`
from the repository root. Review license, row count, checksum, and any new numbering
conventions; update these size/date notices and run the cross-reference tests. Builds and
runtime never download this resource.

`canonical-verses.json` contains KJV chapter bounds derived from CrossWire SWORD's
[`include/canon.h`](https://github.com/ezra-bible-app/crosswire-sword-mirror/blob/1.9.0-2025-12-30/include/canon.h)
(GPL-2.0, Copyright CrossWire Bible Society), with 3 John changed to 15 verses to match
OpenBible. Canonical references use KJV numbering elsewhere; Psalms headings are not verse 0
entries. The strict SWORD wrapper maps source and target keys and rejects unsupported
systems rather than guessing. Supported systems with mapping tables: KJV, KJVA, NRSV,
Synodal, Vulg, Calvin, DarbyFr, Segond. Other systems currently return no external refs.
