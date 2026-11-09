# PDF regression fixture provenance

All fixture content is synthetic and contains no user documents or downloaded samples.

- `pdf-fixtures.ts` authors minimal valid PDFs at test time, with Latin standard-font text, Japanese Type0/CID text, empty content, CMYK color, or an image.
- `red-2x2.jp2`: a 2 by 2 solid RGB red image encoded with bundled Pillow/OpenJPEG.
- `white-8x1.ccitt`: a single 8-pixel row of a solid white 1-bit image, encoded by bundled Pillow/libtiff as Group4; only its 6-byte TIFF strip is retained.
- `white-8x1.jbig2`: an authored PDF-embedded JBIG2 stream with PageInformation and ImmediateGenericRegion segments, wrapping the same MMR strip.
- `password-protected.pdf`: one blank 200 by 200 page, generated with bundled pypdf and RC4-128 encrypted with the non-secret test password `fixture-password`.

These packages were used only to prepare fixtures. They are not application or npm dependencies.
