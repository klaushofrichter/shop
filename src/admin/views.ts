/**
 * Admin pages: plain server-rendered HTML, no inline script or style (the CSP
 * stays strict), everything interpolated through `esc`.
 */
import { esc } from '../pages';

export function adminLayout(o: { title: string; body: string; mode?: string; signedIn?: boolean }): string {
  const banner = o.mode ? `<p class="mode mode-${esc(o.mode)}">${esc(o.mode.toUpperCase())}</p>` : '';
  const nav = o.signedIn
    ? `<nav aria-label="Admin"><a href="/admin">Dashboard</a> <a href="/admin/works">Works</a> <a href="/auth/logout">Sign out</a></nav>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(o.title)} · Shop admin</title>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/shop.css">
</head>
<body class="admin">
<header class="top"><a class="brand" href="/admin">Shop admin</a> ${banner} ${nav}</header>
<main>
${o.body}
</main>
</body>
</html>
`;
}

/** A POST button with the CSRF token. */
export function postButton(action: string, label: string, csrf: string, cls = ''): string {
  return `<form method="post" action="${esc(action)}" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button type="submit"${cls ? ` class="${esc(cls)}"` : ''}>${esc(label)}</button></form>`;
}
