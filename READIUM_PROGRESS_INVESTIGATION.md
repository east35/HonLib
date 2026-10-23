# Readium Progress Investigation

## Why investigate this

HonLib currently stores an EPUB CFI and overall percentage as its reading
position. That works well for the Foliate-based web reader and the Android
shell, but it makes other readers translate their native position into a
HonLib-specific record. The proposed pocket e-reader integration exposed this
limitation: CrossPoint can obtain books through OPDS and synchronize progress
through the KOReader Sync protocol, but its native locator is not a Foliate
CFI.

There is no single universal ebook progress-sync protocol. OPDS covers catalog
discovery and book delivery, while KOReader Sync is a useful compatibility API
whose progress value is deliberately reader-specific. Readium's Locator model
is a better candidate for HonLib's internal representation because it can carry
the publication resource, progress within that resource, total publication
progress, a position index, text context, and format-specific locators such as
an EPUB CFI.

The architectural idea is therefore to standardize HonLib's stored position,
not to replace HonLib's synchronization behavior:

- Store a Readium-shaped locator as the canonical reading position.
- Preserve EPUB CFI as a format-specific locator for the current web reader.
- Retain HonLib's timestamps, stale-write detection, and explicit conflict
  handling.
- Add protocol adapters at the boundary: OPDS for catalog/download and
  KOReader Sync for CrossPoint or KOReader clients.
- Use a stable publication identity, including a content digest, so a device's
  downloaded EPUB can be matched even when its server-side path changes.

## Questions to answer

1. Can Foliate reliably produce and restore the resource `href`, progression,
   total progression, and text context needed for a Readium Locator?
2. Can an EPUB CFI and a CrossPoint/KOReader XPath be converted without losing
   the exact text offset when both clients have the identical EPUB file?
3. Which publication digest algorithm and EPUB normalization rules are required
   for compatibility with CrossPoint and KOReader?
4. How should existing `{cfi, percent, last_opened}` records migrate without
   invalidating active Android queues or browser sessions?
5. Which fields belong in the canonical record versus per-device/native locator
   extensions?
6. Can KOReader Sync authentication be exposed as a compatibility surface
   without weakening HonLib's normal authentication model?

## Proposed investigation

Build a narrow proof of concept around one EPUB and three round trips:

1. Capture a Readium-shaped locator from the HonLib web reader and restore it
   exactly in a new browser session.
2. Convert a representative CrossPoint/KOReader position into that locator and
   restore it in Foliate.
3. Convert the resulting HonLib locator back into the external reader's native
   position and measure whether it returns to the same paragraph and character
   offset.

The investigation should also document failure behavior for changed EPUB
editions. Percentage is an acceptable fallback, but exact positions must only
be exchanged when the publication digest proves both devices have the same
content.

## Expected outcome

The likely result is a versioned progress record based on the Readium Locator
model, with compatibility adapters rather than a rewrite of HonLib around OPDS
or KOReader Sync. If exact bidirectional conversion is unreliable, HonLib can
still adopt the model internally while exposing percentage-only synchronization
to external readers.

References:

- [Readium Locator model](https://readium.org/architecture/models/locators/)
- [Readium locator guidance for EPUB](https://readium.org/architecture/models/locators/best-practices/format.html)
- [KOReader Sync server protocol](https://github.com/koreader/koreader-sync-server)
- [CrossPoint Sync API](https://github.com/crosspoint-reader/crosspoint-sync/blob/main/docs/API.md)
