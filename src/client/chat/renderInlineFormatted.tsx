import React from "react";

function isSafeUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  if (
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("vbscript:")
  ) {
    return false;
  }
  return (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("/")
  );
}

export function renderInlineFormatted(text: string) {
  // Split on bold (**text**), inline code (`code`), markdown links ([text](url)), job paths (/api/jobs/uuid), and full URLs
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|\/api\/jobs\/[a-zA-Z0-9_-]+|https?:\/\/[^\s<>)"]+)/g);
  return tokens.map((token, i) => {
    if (token.startsWith("`") && token.endsWith("`") && token.length > 2) {
      return <code key={i} className="inline-code">{token.slice(1, -1)}</code>;
    }
    if (token.startsWith("**") && token.endsWith("**") && token.length > 4) {
      return <strong key={i} className="bold-text">{token.slice(2, -2)}</strong>;
    }
    const mdLinkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (mdLinkMatch) {
      const [, label, url] = mdLinkMatch;
      if (isSafeUrl(url)) {
        return (
          <a
            key={i}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="chat-link"
          >
            {label}
          </a>
        );
      }
      return token;
    }
    if (token.startsWith("/api/jobs/")) {
      return (
        <a
          key={i}
          href={token}
          target="_blank"
          rel="noopener noreferrer"
          className="chat-link chat-job-link"
        >
          {token}
        </a>
      );
    }
    if (token.startsWith("http://") || token.startsWith("https://")) {
      return (
        <a
          key={i}
          href={token}
          target="_blank"
          rel="noopener noreferrer"
          className="chat-link"
        >
          {token}
        </a>
      );
    }
    return token;
  });
}

