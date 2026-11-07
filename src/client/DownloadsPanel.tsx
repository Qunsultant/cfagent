import React, { useState } from "react";
import { Button, TextInput, Card, Stack, Flex, Grid } from "./components/ui";
import { OptionsDataDownloadDropdown } from "./options/OptionsDataDownloadDropdown";
import { useBrokerEnvironment } from "./brokerEnvironment";

export interface DownloadsPanelProps {
  activeEnv?: "TEST" | "PROD";
  userLogin?: string;
}

const POPULAR_SYMBOLS = ["NVDA", "AAPL", "SPY", "QQQ", "TSLA", "MSFT", "AMZN"];

export function DownloadsPanel({ activeEnv, userLogin }: DownloadsPanelProps) {
  const brokerEnv = useBrokerEnvironment();
  const effectiveEnv = activeEnv ?? brokerEnv;
  const [symbol, setSymbol] = useState("NVDA");

  return (
    <div className="downloads-panel">
      <div className="section-label-row">
        <span>Parameters &amp; Options Data Export</span>
        <small>Download comprehensive options datasets, Greek surfaces, and historical chain parameters</small>
      </div>

      <Stack gap="4" className="downloads-content">
        <Card padding="md">
          <Stack gap="3">
            <div>
              <h4 className="downloads-card-title">Options Chain &amp; Dataset Download</h4>
              <p className="downloads-card-sub">
                Select an underlying ticker to export its live options chain across all strikes, maturities, and Greeks.
              </p>
            </div>

            <Flex align="center" gap="3" wrap>
              <div className="downloads-ticker-field">
                <TextInput
                  id="export-ticker-input"
                  label="Underlying Symbol"
                  type="text"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  placeholder="NVDA"
                  maxLength={10}
                />
              </div>

              <div className="downloads-action-btn">
                <OptionsDataDownloadDropdown
                  symbol={symbol.trim() || "NVDA"}
                  activeEnv={effectiveEnv}
                  userLogin={userLogin}
                  label={`📥 Export ${symbol.trim() || "NVDA"} Options Data`}
                  className="downloads-export-btn"
                />
              </div>
            </Flex>

            <Flex align="center" gap="2" wrap>
              <span className="downloads-popular-label">Popular:</span>
              {POPULAR_SYMBOLS.map((sym) => (
                <Button
                  key={sym}
                  size="sm"
                  variant={symbol === sym ? "accent" : "secondary"}
                  onClick={() => setSymbol(sym)}
                >
                  {sym}
                </Button>
              ))}
            </Flex>
          </Stack>
        </Card>

        <Card padding="md">
          <Stack gap="3">
            <h4 className="downloads-card-title">Export Formats &amp; Data Dictionary</h4>
            <Grid columns={3} gap="3">
              <div className="downloads-format-card">
                <strong>📊 CSV Format (.csv)</strong>
                <p className="downloads-format-desc">
                  Tabular structure suitable for spreadsheet modeling in Excel, Google Sheets, or Python pandas analysis. Includes all strikes, bid, ask, volume, open interest, and Black-Scholes Greeks.
                </p>
              </div>
              <div className="downloads-format-card">
                <strong>📋 Excel Format (.xlsx)</strong>
                <p className="downloads-format-desc">
                  Multi-tab workbook containing formatted Calls, Puts, Greek Surfaces, and Volatility Skew summary with column auto-widths and numeric formatting.
                </p>
              </div>
              <div className="downloads-format-card">
                <strong>🔧 JSON Format (.json)</strong>
                <p className="downloads-format-desc">
                  Raw structured JSON payload matching the ETAPI schema, perfect for programmatic consumption, pipeline feeds, and custom backtesting engines.
                </p>
              </div>
            </Grid>
          </Stack>
        </Card>
      </Stack>
    </div>
  );
}
