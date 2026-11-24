# ADR-0019: Print files exist and validate before a product is sold; their URLs never change

- Status: Accepted
- Date: 2026-11-24
- Decided by: Klaus, 2026-11-24 (accepted with group 1: "yes, accept group 1")

## Context

Pressline learned that "we took the money and the file was bad" is the worst failure, and that Printful re-fetches print files by URL for reprints and caches them by URL. Printful silently upscales low-resolution files and silently ignored a 213 MB file in Pressline's live test. Paintings photographed with a camera may carry an Adobe RGB profile.

## Decision

- A (picture, SKU) can be offered only after its print file was rendered and validated: exact pixel size for the print area, 8-bit sRGB, no alpha on paper, under 200 MB, effective DPI above the SKU's floor.
- Print files are served at **immutable, content-addressed URLs** (`/files/<sha256>.jpg`), unguessable and never expiring; a changed crop or source makes a new file and URL. This replaces the 7-day signed URLs first proposed in ADR-0006.
- Colour: convert to sRGB at render time; the admin shows the result as it will be printed.

## Consequences

- A print file reachable by its URL is a full-resolution copy of a painting for anyone who has the URL. Only Printful and the admin ever see the URLs. If that is not acceptable, the alternative is Printful's file library (upload once, refer by id), which still needs a URL Printful can fetch once.
- Re-rendering every file after a source change is a job, not a request.
