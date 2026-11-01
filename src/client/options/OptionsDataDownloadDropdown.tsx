/**
 * OptionsDataDownloadDropdown — the download menu for raw /
 * normalized options-data packages.
 *
 * C2 (consolidation #1151, issue #1246): this component is all that
 * remains of options/optionsDataExporter.tsx — its data functions
 * (fetchOptionsDataForExport, buildExportInput, downloadRawOptionsData,
 * downloadNormalizedOptionsData, downloadBothOptionsData) moved into
 * the ONE client exporter, ../runExport.ts, and this component now
 * imports them from there.
 */
import { useState, useRef, useEffect } from "react";
import { Button } from "../components/ui";
import {
  downloadRawOptionsData,
  downloadNormalizedOptionsData,
  downloadBothOptionsData,
} from "../runExport";
import "./strategyDiscovery.css";

export interface OptionsDataDownloadDropdownProps {
  symbol: string;
  activeEnv?: "TEST" | "PROD";
  userLogin?: string;
  label?: string;
  className?: string;
}

export function OptionsDataDownloadDropdown({
  symbol,
  activeEnv = "TEST",
  userLogin,
  label = "📥 Download Options Data",
  className = "",
}: OptionsDataDownloadDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [downloading, setDownloading] = useState<"raw" | "normalized" | "both" | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleDownload = async (type: "raw" | "normalized" | "both") => {
    const sym = symbol.trim().toUpperCase() || "SPY";
    setDownloading(type);
    setErrorMessage("");
    setStatusMessage(`Retrieving complete chains for ${sym}…`);
    try {
      if (type === "raw") {
        await downloadRawOptionsData(sym, activeEnv, userLogin);
        setStatusMessage(`Downloaded raw E*TRADE options data for ${sym} (.xls)`);
      } else if (type === "normalized") {
        await downloadNormalizedOptionsData(sym, activeEnv, userLogin);
        setStatusMessage(`Downloaded normalized LLM input data for ${sym} (.xls)`);
      } else {
        await downloadBothOptionsData(sym, activeEnv, userLogin);
        setStatusMessage(`Downloaded raw & normalized options packages for ${sym} (.xls)`);
      }
      setTimeout(() => {
        setStatusMessage("");
        setIsOpen(false);
      }, 2500);
    } catch (err) {
      setStatusMessage("");
      setErrorMessage(err instanceof Error ? err.message : "Failed to download options data.");
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className={`options-download-dropdown-wrap ${className}`} ref={dropdownRef}>
      <Button
        type="button"
        className="options-download-main-btn"
        onClick={() => setIsOpen(!isOpen)}
        disabled={downloading !== null}
        title={`Download raw and normalized options datasets for ${symbol.toUpperCase()}`}
       loading={downloading !== null}>
        {`${label} ▾`}
      </Button>

      {isOpen && (
        <div className="options-download-menu">
          <div className="options-download-menu-header">
            <strong>Download Options Data for {symbol.toUpperCase()}</strong>
            <span>Excel 97–2003 (.xls) Workbooks</span>
          </div>

          <Button
            type="button"
            className="options-download-menu-item"
            disabled={downloading !== null}
            onClick={() => void handleDownload("raw")}
          >
            <div className="menu-item-icon">📦</div>
            <div className="menu-item-text">
              <strong>Raw E*TRADE Options Data</strong>
              <small>Complete unadulterated option chain JSON &amp; expirations</small>
            </div>
          </Button>

          <Button
            type="button"
            className="options-download-menu-item"
            disabled={downloading !== null}
            onClick={() => void handleDownload("normalized")}
          >
            <div className="menu-item-icon">📊</div>
            <div className="menu-item-text">
              <strong>Normalized LLM Input Data</strong>
              <small>Grouped contracts, Greeks, and exact prompts fed to LLM</small>
            </div>
          </Button>

          <Button
            type="button"
            className="options-download-menu-item highlight"
            disabled={downloading !== null}
            onClick={() => void handleDownload("both")}
          >
            <div className="menu-item-icon">📁</div>
            <div className="menu-item-text">
              <strong>Download Both Packages</strong>
              <small>Both raw E*TRADE chains and normalized LLM inputs</small>
            </div>
          </Button>

          {statusMessage && <div className="options-download-status success">{statusMessage}</div>}
          {errorMessage && <div className="options-download-status error">{errorMessage}</div>}
        </div>
      )}
    </div>
  );
}
