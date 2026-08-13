// Vendored from @earendil-works/pi (packages/ai/src/auth/oauth/oauth-page.ts),
// MIT License, Copyright (c) 2025 Mario Zechner. See THIRD_PARTY_NOTICES.md.
// Modified: pi's logo replaced with a plain InfraWiki wordmark.

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPage(options: {
  title: string;
  heading: string;
  message: string;
  details?: string;
}): string {
  const title = escapeHtml(options.title);
  const heading = escapeHtml(options.heading);
  const message = escapeHtml(options.message);
  const details = options.details ? escapeHtml(options.details) : undefined;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --page-bg: #09090b;
      --font-sans: ui-sans-serif, system-ui, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main { max-width: 560px; }
    .wordmark {
      font-family: var(--font-mono);
      font-size: 15px;
      letter-spacing: 0.2em;
      color: var(--text-dim);
      margin-bottom: 24px;
    }
    h1 { margin: 0 0 10px; font-size: 28px; font-weight: 650; }
    p { margin: 0; line-height: 1.7; color: var(--text-dim); font-size: 15px; }
    .details {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <div class="wordmark">INFRAWIKI</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

export function oauthSuccessHtml(message: string): string {
  return renderPage({
    title: "Authentication successful",
    heading: "Authentication successful",
    message,
  });
}

export function oauthErrorHtml(message: string, details?: string): string {
  return renderPage({
    title: "Authentication failed",
    heading: "Authentication failed",
    message,
    details,
  });
}
