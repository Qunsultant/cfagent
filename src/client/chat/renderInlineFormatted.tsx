import React from "react";

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
      return (
        <a
          key={i}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="chat-link"
          style={{ textDecoration: "underline" }}
        >
          {label}
        </a>
      );
    }
    if (token.startsWith("/api/jobs/")) {
      return (
        <a
          key={i}
          href={token}
          target="_blank"
          rel="noopener noreferrer"
          className="chat-link chat-job-link"
          style={{ textDecoration: "underline", fontFamily: "var(--font-mono)" }}
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
          style={{ textDecoration: "underline" }}
        >
          {token}
        </a>
      );
    }
    return token;
  });
}

