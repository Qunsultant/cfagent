import React, { useState } from "react";
import { renderInlineFormatted } from "./renderInlineFormatted";
import { OptionsStrategyCard } from "./OptionsStrategyCard";
import { Button } from "../components/ui/Button";

function tryParseOptionsData(code: string): any | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return null;
    const hasStrategy = Boolean(parsed.strategy || parsed.label || parsed.type || parsed.symbol);
    const hasLegs = Array.isArray(parsed.legs) || Array.isArray(parsed.tradePlan);
    const hasOptionsKeywords = Boolean(
      parsed.maxProfit !== undefined ||
      parsed.maxLoss !== undefined ||
      parsed.probabilityOfProfit !== undefined ||
      parsed.breakevens !== undefined ||
      parsed.netGreeks !== undefined
    );
    if (hasStrategy && (hasLegs || hasOptionsKeywords)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function OptionsBlockView({
  optionsData,
  rawCode,
  lang,
  onAction,
}: {
  optionsData: any;
  rawCode: string;
  lang: string;
  onAction?: (actionPrompt: string) => void;
}) {
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div className="options-structured-block" style={{ margin: "var(--space-2) 0" }}>
      <OptionsStrategyCard data={optionsData} onAction={onAction} />
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--space-1)" }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowRaw(!showRaw)}
          title="Toggle underlying raw JSON code block"
        >
          {showRaw ? "Hide Raw Code ▲" : "View Raw JSON ▼"}
        </Button>
      </div>
      {showRaw && (
        <div className="code-block-container" style={{ marginTop: "var(--space-1)" }}>
          {lang && <div className="code-lang-tag">{lang}</div>}
          <pre className="code-block">
            <code>{rawCode}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * Lightweight markdown formatter for bold, code blocks, inline code, and lists,
 * with structured options card parsing for code blocks.
 */
export function MarkdownContent({
  text,
  onAction,
}: {
  text: string;
  onAction?: (actionPrompt: string) => void;
}) {
  if (!text) return null;

  // Split text by markdown code blocks
  const parts = text.split(/(```[\s\S]*?```)/g);

  return (
    <div className="markdown-body">
      {parts.map((part, idx) => {
        if (part.startsWith("```") && part.endsWith("```")) {
          const lines = part.slice(3, -3).trim().split("\n");
          const firstLine = lines[0].trim();
          const hasLang = /^[a-zA-Z0-9_-]+$/.test(firstLine);
          const lang = hasLang ? firstLine : "";
          const code = (hasLang ? lines.slice(1) : lines).join("\n");

          const optionsData = tryParseOptionsData(code);
          if (optionsData) {
            return (
              <OptionsBlockView
                key={idx}
                optionsData={optionsData}
                rawCode={code}
                lang={lang || "json"}
                onAction={onAction}
              />
            );
          }

          return (
            <div key={idx} className="code-block-container">
              {lang && <div className="code-lang-tag">{lang}</div>}
              <pre className="code-block">
                <code>{code}</code>
              </pre>
            </div>
          );
        }

        // Inline formatting for non-code block segments
        const paragraphs = part.split(/\n\n+/);
        return (
          <React.Fragment key={idx}>
            {paragraphs.map((p, pIdx) => {
              const lines = p.split("\n");
              return (
                <p key={pIdx} className="message-p">
                  {lines.map((line, lIdx) => {
                    const isListItem = line.trim().startsWith("- ") || line.trim().startsWith("* ");
                    const content = isListItem ? line.trim().slice(2) : line;

                    return (
                      <span key={lIdx} className={isListItem ? "list-item" : "inline-line"}>
                        {isListItem && <span className="bullet">• </span>}
                        {renderInlineFormatted(content)}
                        {lIdx < lines.length - 1 && !isListItem && <br />}
                      </span>
                    );
                  })}
                </p>
              );
            })}
          </React.Fragment>
        );
      })}
    </div>
  );
}
