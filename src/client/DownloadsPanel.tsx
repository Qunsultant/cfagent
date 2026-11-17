import React, { useState } from "react";
import { Button, CardHeader, TextInput, Card, PageSection, Stack, Flex, Grid } from "./components/ui";
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
    <PageSection>
      <CardHeader
        title="Parameters & Options Data Export"
        subtitle="Download comprehensive options datasets, Greek surfaces, and historical chain parameters"
      />

      <Stack gap="4">
        <Card>
          <Stack gap="3">
            <div>
              <CardHeader title="Options Chain & Dataset Download" />
              <p className="ui-meta">
                Select an underlying ticker to export its live options chain across all strikes, maturities, and Greeks.
              </p>
            </div>

            <Flex align="center" gap="3" wrap>
              <TextInput
                id="export-ticker-input"
                label="Underlying Symbol"
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                placeholder="NVDA"
                maxLength={10}
              />

              <OptionsDataDownloadDropdown
                symbol={symbol.trim() || "NVDA"}
                activeEnv={effectiveEnv}
                userLogin={userLogin}
                label={`📥 Export ${symbol.trim() || "NVDA"} Options Data`}
              />
            </Flex>

            <Flex align="center" gap="2" wrap>
              <span>Popular:</span>
              {POPULAR_SYMBOLS.map((sym) => (
                <Button
                  key={sym}
                  size="sm"
                  variant={symbol === sym ? "primary" : "secondary"}
                  onClick={() => setSymbol(sym)}
                >
                  {sym}
                </Button>
              ))}
            </Flex>
          </Stack>
        </Card>

        <Card>
          <Stack gap="3">
            <CardHeader title="Export Formats & Data Dictionary" />
            <Grid columns={3} gap="3">
              <div>
                <strong>📊 CSV Format (.csv)</strong>
                <p>
                  Tabular structure suitable for spreadsheet modeling in Excel, Google Sheets, or Python pandas analysis. Includes all strikes, bid, ask, volume, open interest, and Black-Scholes Greeks.
                </p>
              </div>
              <div>
                <strong>📋 Excel Format (.xlsx)</strong>
                <p>
                  Multi-tab workbook containing formatted Calls, Puts, Greek Surfaces, and Volatility Skew summary with column auto-widths and numeric formatting.
                </p>
              </div>
              <div>
                <strong>🔧 JSON Format (.json)</strong>
                <p>
                  Raw structured JSON payload matching the ETAPI schema, perfect for programmatic consumption, pipeline feeds, and custom backtesting engines.
                </p>
              </div>
            </Grid>
          </Stack>
        </Card>
      </Stack>
    </PageSection>
  );
}
