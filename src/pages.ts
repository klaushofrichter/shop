/**
 * Server-rendered pages (ADR-0004). Everything interpolated goes through
 * `esc`, and the pages carry no inline script or style, so the Content
 * Security Policy in app.ts can stay strict.
 */
export const ART_URL = 'https://art.klaushofrichter.net/';

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Layout {
  title: string;
  description: string;
  body: string;
}

export function layout({ title, description, body }: Layout): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/shop.css">
</head>
<body>
<header class="top"><a class="brand" href="/">Shop</a> <span class="by">prints of paintings by Klaus Hofrichter</span></header>
<main>
${body}
</main>
<footer class="bottom"><a href="${ART_URL}">art.klaushofrichter.net</a></footer>
</body>
</html>
`;
}

export function homePage(): string {
  return layout({
    title: 'Prints of paintings by Klaus Hofrichter',
    description: 'Prints, framed prints and merchandise of the paintings by Klaus Hofrichter shown at art.klaushofrichter.net.',
    body: `<h1>Prints of paintings by Klaus Hofrichter</h1>
<p>Postcards, prints, framed prints, mugs and t-shirts of the paintings in the gallery are coming here soon.</p>
<p>Until then, the paintings are on view at <a href="${ART_URL}">art.klaushofrichter.net</a>.</p>`,
  });
}

export function notFoundPage(): string {
  return layout({
    title: 'Not found · Shop',
    description: 'This page does not exist.',
    body: `<h1>Not found</h1>
<p>There is no page at this address. <a href="/">Back to the shop</a>, or visit the <a href="${ART_URL}">gallery</a>.</p>`,
  });
}
