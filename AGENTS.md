# Working agreements

Keep this package self-contained: runtime code and pricing live in this repository; runtime dependencies remain empty.

Release: before changing versions, editing release automation, pushing tags, or recovering a failed publish, read [docs/releasing.md](docs/releasing.md). That document owns the release procedure and completion criteria.

Pricing: preserve model aliases, provider overrides and unknown-price behavior when editing `src/model-pricing.ts`; account for changed rates in the pricing tests and release notes.
