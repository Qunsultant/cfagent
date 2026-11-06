import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";
import type { Env } from "../src/types";
import { ETradeRestClient } from "../src/trading/etrade/client";
import { ETradeService } from "../src/services/etrade";
import {
  getETradeRequestToken,
  exchangeETradeVerifier,
  renewETradeAccessToken,
  revokeRemoteAccessToken,
  storeAccessTokens,
} from "../src/security/etradeOAuth";

describe("E*TRADE All Official Endpoints Suite (Full 23-Endpoint Validation)", () => {
  let env: Env;
  let kvStorage: Record<string, string>;
  const userLogin = "test_trader_endpoints";

  beforeEach(() => {
    vi.restoreAllMocks();
    kvStorage = {};
    const mockKv = {
      get: vi.fn(async (k: string) => kvStorage[k] || null),
      put: vi.fn(async (k: string, v: string) => {
        kvStorage[k] = v;
      }),
      delete: vi.fn(async (k: string) => {
        delete kvStorage[k];
      }),
    } as any;

    const { namespace: sessionStoreNs } = makeFakeSessionStore();

    env = {
      APP_NAME: "cfagent-test",
      APP_BASE_URL: "https://agent.openaimp.com",
      SESSION_SECRET: "test_secret_32_characters_minimum_len",
      GITHUB_CLIENT_ID: "gh_id",
      GITHUB_CLIENT_SECRET: "gh_sec",
      AI_SEARCH_ENDPOINT: "https://ai.example.com",
      SESSION_STORE: sessionStoreNs,
      ETRADE_KV: mockKv,
      ORCHESTRATOR_AGENT: {} as any,
      ASSETS: {} as any,
      AI: {} as any,
      APP_ENV: "TEST",
      ET_API_KEY: "sandbox_consumer_key_123",
      ET_API_SECRET: "sandbox_consumer_secret_456",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
      ETRADE_ACCOUNT_ID_KEY: "ACCOUNT_KEY_XYZ999",
    };
  });

  describe("Module 1: Authorization Endpoints", () => {
    it("1. GET /oauth/request_token & 2. Authorize URL", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("oauth_token=req_token_111&oauth_token_secret=req_sec_222", { status: 200 })
      );

      const res = await getETradeRequestToken(env, userLogin);
      expect(res.requestToken).toBe("req_token_111");
      expect(res.requestTokenSecret).toBe("req_sec_222");
      expect(res.authorizeUrl).toContain("https://us.etrade.com/e/t/etws/authorize?key=sandbox_consumer_key_123&token=req_token_111");
    });

    it("3. GET /oauth/access_token", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("oauth_token=acc_token_333&oauth_token_secret=acc_sec_444", { status: 200 })
      );

      const tokens = await exchangeETradeVerifier(env, userLogin, "99999", "req_token_111", "req_sec_222");
      expect(tokens.accessToken).toBe("acc_token_333");
      expect(tokens.accessTokenSecret).toBe("acc_sec_444");
    });

    it("4. GET /oauth/renew_access_token", async () => {
      await storeAccessTokens(env, userLogin, "acc_token_333", "acc_sec_444");
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Access Token Renewed", { status: 200 })
      );

      const renewed = await renewETradeAccessToken(env, userLogin);
      expect(renewed).not.toBeNull();
      expect(fetchSpy.mock.calls[0][0]).toBe("https://apisb.etrade.com/oauth/renew_access_token");
    });

    it("5. GET /oauth/revoke_access_token", async () => {
      await storeAccessTokens(env, userLogin, "acc_token_333", "acc_sec_444");
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Revoked Access Token", { status: 200 })
      );

      const res = await revokeRemoteAccessToken(env, userLogin);
      expect(res.success).toBe(true);
      expect(fetchSpy.mock.calls[0][0]).toBe("https://apisb.etrade.com/oauth/revoke_access_token");
    });
  });

  describe("Module 2: Accounts Endpoints", () => {
    it("6. GET /v1/accounts/list", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            AccountListResponse: {
              Accounts: {
                Account: [{ accountId: "12345", accountIdKey: "KEY_12345", accountDesc: "Brokerage", accountType: "MARGIN" }],
              },
            },
          }),
          { status: 200 }
        )
      );

      const accounts = await client.fetchAccounts();
      expect(accounts.length).toBe(1);
      expect(accounts[0].accountKey).toBe("KEY_12345");
    });

    it("7. GET /v1/accounts/{accountIdKey}/balance", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            BalanceResponse: {
              Computed: {
                cashBuyingPower: 12500,
                marginBuyingPower: 25000,
                RealTimeValues: { totalAccountValue: 55000 },
              },
            },
          }),
          { status: 200 }
        )
      );

      const balance = await client.fetchBalance("KEY_12345");
      expect(balance?.netAccountValue).toBe(55000);
      expect(balance?.cashBuyingPower).toBe(12500);
      expect(fetchSpy.mock.calls[0][0]).toContain("/accounts/KEY_12345/balance");
    });

    it("8. GET /v1/accounts/{accountIdKey}/transactions", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            TransactionListResponse: {
              Transaction: [
                { transactionId: "txn_001", accountId: "12345", transactionDate: 1727740800000, amount: -1450.50, description: "Bought 10 NVDA", transactionType: "Trade" },
              ],
            },
          }),
          { status: 200 }
        )
      );

      const txns = await client.fetchTransactions("KEY_12345", { count: 10 });
      expect(txns.length).toBe(1);
      expect(txns[0].transactionId).toBe("txn_001");
      expect(fetchSpy.mock.calls[0][0]).toContain("/accounts/KEY_12345/transactions?count=10");
    });

    it("9. GET /v1/accounts/{accountIdKey}/transactions/{transactionId}", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            TransactionDetailsResponse: {
              transactionId: "txn_001",
              accountId: "12345",
              transactionDate: 1727740800000,
              amount: -1450.50,
              description: "Bought 10 NVDA",
              Brokerage: {
                Product: { symbol: "NVDA", securityType: "EQ" },
                quantity: 10,
                price: 145.05,
                fee: 0.0,
              },
            },
          }),
          { status: 200 }
        )
      );

      const details = await client.fetchTransactionDetails("KEY_12345", "txn_001");
      expect(details?.transactionId).toBe("txn_001");
      expect(details?.brokerage?.product?.symbol).toBe("NVDA");
      expect(fetchSpy.mock.calls[0][0]).toContain("/accounts/KEY_12345/transactions/txn_001");
    });

    it("10. GET /v1/accounts/{accountIdKey}/portfolio", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            PortfolioResponse: {
              Totals: { totalMarketValue: 75000, cashBalance: 15000 },
              AccountPortfolio: [
                {
                  Position: [
                    {
                      positionId: 101,
                      Product: { symbol: "AAPL", securityType: "EQ" },
                      quantity: 50,
                      pricePaid: 200,
                      marketValue: 11000,
                      Quick: { lastTrade: 220, change: 2.5, quoteStatus: "REALTIME" },
                    },
                  ],
                },
              ],
            },
          }),
          { status: 200 }
        )
      );

      const portfolio = await client.fetchPortfolio("KEY_12345", false, { view: "QUICK", totalsRequired: true });
      expect(portfolio?.account.netAccountValue).toBe(75000);
      expect(portfolio?.account.cashAvailableForInvestment).toBe(15000);
      expect(portfolio?.positions[0].symbol).toBe("AAPL");
      expect(portfolio?.positions[0].currentPrice).toBe(220);
      expect(fetchSpy.mock.calls[0][0]).toContain("/accounts/KEY_12345/portfolio?view=QUICK&totalsRequired=true");
    });

    it("10b. GET /v1/accounts/{accountIdKey}/portfolio/{positionId}", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            PositionLotsResponse: {
              PositionLot: [
                {
                  positionId: 101,
                  positionLotId: 10087531,
                  price: 195.5,
                  marketValue: 9775,
                  totalCost: 9775,
                  totalGain: 1225,
                  totalGainPct: 12.53,
                  remainingQty: 50,
                  availableQty: 50,
                },
              ],
            },
          }),
          { status: 200 }
        )
      );

      const lots = await client.fetchPositionLots("KEY_12345", "101");
      expect(lots.length).toBe(1);
      expect(lots[0].positionLotId).toBe(10087531);
      expect(lots[0].price).toBe(195.5);
      expect(lots[0].totalGain).toBe(1225);
      expect(fetchSpy.mock.calls[0][0]).toContain("/accounts/KEY_12345/portfolio/101");
    });
  });

  describe("Module 3: Alerts Endpoints", () => {
    it("11. GET /v1/user/alerts", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            AlertsResponse: {
              Alert: [{ id: 5001, createTime: 1727740800, subject: "Price Alert: NVDA crossed $140", status: "UNREAD" }],
            },
          }),
          { status: 200 }
        )
      );

      const alerts = await client.fetchAlerts({ count: 5 });
      expect(alerts.length).toBe(1);
      expect(alerts[0].id).toBe(5001);
      expect(fetchSpy.mock.calls[0][0]).toContain("/user/alerts?count=5");
    });

    it("12. GET /v1/user/alerts/{alertId}", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            AlertDetailsResponse: {
              id: 5001,
              createTime: 1727740800,
              subject: "Price Alert: NVDA",
              msgText: "NVDA reached price target of $140.00",
            },
          }),
          { status: 200 }
        )
      );

      const details = await client.fetchAlertDetails(5001);
      expect(details?.id).toBe(5001);
      expect(details?.msgText).toContain("target of $140.00");
      expect(fetchSpy.mock.calls[0][0]).toContain("/user/alerts/5001");
    });

    it("13. DELETE /v1/user/alerts/{alertId}", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      const res = await client.deleteAlert(5001);
      expect(res.success).toBe(true);
      expect(fetchSpy.mock.calls[0][0]).toContain("/user/alerts/5001");
    });
  });

  describe("Module 4: Market Endpoints", () => {
    it("14. GET /v1/market/quote/{symbols}", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            QuoteResponse: {
              QuoteData: [
                {
                  Product: { symbol: "NVDA" },
                  All: { symbol: "NVDA", companyName: "NVIDIA Corp", lastTrade: 142.50, changeClose: 3.2, bid: 142.45, ask: 142.55 },
                },
              ],
            },
          }),
          { status: 200 }
        )
      );

      const quote = await client.fetchQuote("NVDA");
      expect(quote?.symbol).toBe("NVDA");
      expect(quote?.lastPrice).toBe(142.50);
      expect(fetchSpy.mock.calls[0][0]).toContain("/market/quote/NVDA");
    });

    it("15. GET /v1/market/lookup/{search}", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            LookupResponse: {
              Data: [
                { symbol: "MSFT", description: "Microsoft Corp", type: "EQUITY" },
              ],
            },
          }),
          { status: 200 }
        )
      );

      const items = await client.lookupProduct("micro");
      expect(items.length).toBe(1);
      expect(items[0].symbol).toBe("MSFT");
      expect(fetchSpy.mock.calls[0][0]).toContain("/market/lookup/micro");
    });

    it("16. GET /v1/market/optionchains", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            OptionChainResponse: {
              nearPrice: 142.50,
              OptionPair: [
                {
                  Call: {
                    symbol: "NVDA--261016C00145000",
                    strikePrice: 145,
                    bid: 5.20,
                    ask: 5.40,
                    bidSize: 12,
                    askSize: 15,
                    lastPrice: 5.30,
                    timeStamp: Date.now(),
                    adjustedFlag: false,
                  },
                  Put: { symbol: "NVDA--261016P00145000", strikePrice: 145, bid: 6.10, ask: 6.30, lastPrice: 6.20 },
                },
              ],
            },
          }),
          { status: 200 }
        )
      );

      const chain = await client.getOptionChains({ symbol: "NVDA", strikePrice: 145 });
      expect(chain?.symbol).toBe("NVDA");
      expect(chain?.pairs[0].call?.strikePrice).toBe(145);
      expect(chain?.pairs[0].call?.timeStamp).toBeDefined();
      expect(chain?.pairs[0].call?.adjustedFlag).toBe(false);
      expect(chain?.pairs[0].call?.bidSize).toBe(12);
      expect(chain?.pairs[0].call?.askSize).toBe(15);
      expect(fetchSpy.mock.calls[0][0]).toContain("/market/optionchains?symbol=NVDA&strikePrice=145");
    });

    it("17. GET /v1/market/optionexpiredate", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            OptionExpireDateResponse: {
              ExpirationDate: [{ year: 2026, month: 10, day: 16, expiryType: "MONTHLY" }],
            },
          }),
          { status: 200 }
        )
      );

      const dates = await client.getOptionExpireDates("NVDA");
      expect(dates.length).toBe(1);
      expect(dates[0].year).toBe(2026);
      expect(fetchSpy.mock.calls[0][0]).toContain("/market/optionexpiredate?symbol=NVDA");
    });
  });

  describe("Module 5: Order Endpoints", () => {
    it("18. GET /v1/accounts/{accountIdKey}/orders", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            OrdersResponse: {
              Order: [
                {
                  orderId: 9001,
                  status: "OPEN",
                  OrderDetail: [
                    {
                      orderType: "EQ",
                      Instrument: [{ Product: { symbol: "NVDA" }, orderAction: "BUY", orderedQuantity: 20 }],
                    },
                  ],
                },
              ],
            },
          }),
          { status: 200 }
        )
      );

      const orders = await client.fetchOrders("KEY_12345");
      expect(orders.length).toBe(1);
      expect(orders[0].orderId).toBe(9001);
      expect(fetchSpy.mock.calls[0][0]).toContain("/accounts/KEY_12345/orders");
    });

    it("18b. POST /v1/accounts/{accountIdKey}/orders/preview", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            PreviewOrderResponse: {
              PreviewIds: [{ previewId: "prev_init_123" }],
              Order: [{ estimatedTotalAmount: 1450.50, estimatedCommission: 0.0 }],
            },
          }),
          { status: 200 }
        )
      );

      const res = await client.previewOrder("KEY_12345", {
        orderId: "client_prev_1",
        symbol: "NVDA",
        action: "BUY",
        quantity: 10,
        orderType: "MARKET",
      });

      expect(res?.previewId).toBe("prev_init_123");
      expect(res?.estimatedTotal).toBe(1450.50);
      expect(fetchSpy.mock.calls[0][0]).toContain("/accounts/KEY_12345/orders/preview");
    });

    it("18c. GET /v1/accounts/{accountIdKey}/orders/{orderId}", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            OrdersResponse: {
              Order: [
                {
                  orderId: 9005,
                  detailsURI: "https://api.etrade.com/v1/accounts/KEY_12345/orders/9005",
                  OrderDetail: [
                    {
                      orderType: "EQ",
                      status: "EXECUTED",
                      placedTime: 1727740800000,
                      executedTime: 1727740805000,
                      Instrument: [{ Product: { symbol: "AAPL" }, orderAction: "BUY", orderedQuantity: 50 }],
                    },
                  ],
                },
              ],
            },
          }),
          { status: 200 }
        )
      );

      const order = await client.fetchOrderDetails("KEY_12345", 9005);
      expect(order?.orderId).toBe(9005);
      expect(order?.symbol).toBe("AAPL");
      expect(order?.status).toBe("EXECUTED");
      expect(fetchSpy.mock.calls[0][0]).toContain("/accounts/KEY_12345/orders/9005");
    });

    it("19. POST /v1/accounts/{accountIdKey}/orders/place", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            PlaceOrderResponse: {
              OrderIds: [{ orderId: 9002 }],
            },
          }),
          { status: 200 }
        )
      );

      const res = await client.placeOrder({
        orderId: "client_ord_1",
        symbol: "NVDA",
        action: "BUY",
        quantity: 10,
        userLogin: `did:user:${userLogin}`,
      });

      expect(res.success).toBe(true);
      expect(res.executionId).toBe("et_order_9002");
      expect(fetchSpy.mock.calls[0][0]).toContain("/accounts/ACCOUNT_KEY_XYZ999/orders/place");
    });

    it("20. PUT /v1/accounts/{accountIdKey}/orders/cancel", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            CancelOrderResponse: {
              messages: { Message: [{ description: "Order 9001 successfully cancelled" }] },
            },
          }),
          { status: 200 }
        )
      );

      const res = await client.cancelOrder("KEY_12345", 9001);
      expect(res.success).toBe(true);
      expect(fetchSpy.mock.calls[0][0]).toContain("/accounts/KEY_12345/orders/cancel");
    });

    it("21. POST /v1/accounts/{accountIdKey}/orders/change/preview", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const previewSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            PreviewOrderResponse: {
              PreviewIds: [{ previewId: "prev_chg_777" }],
            },
          }),
          { status: 200 }
        )
      );

      const previewRes = await client.changeOrderPreview("KEY_12345", {
        orderId: 9001,
        symbol: "NVDA",
        action: "BUY",
        quantity: 15,
        limitPrice: 140.0,
      });

      expect(previewSpy.mock.calls[0][0]).toContain("/accounts/KEY_12345/orders/change/preview");
    });

    it("22. POST /v1/accounts/{accountIdKey}/orders/change/place", async () => {
      await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
      const client = new ETradeRestClient(env, userLogin);

      const placeSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            PlaceOrderResponse: {
              OrderIds: [{ orderId: 9003 }],
            },
          }),
          { status: 200 }
        )
      );

      const placeRes = await client.changeOrderPlace("KEY_12345", {
        orderId: 9001,
        previewId: "prev_chg_777",
        symbol: "NVDA",
        action: "BUY",
        quantity: 15,
      });

      expect(placeSpy.mock.calls[0][0]).toContain("/accounts/KEY_12345/orders/change/place");
    });
  });
});
