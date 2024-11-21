import { Logger } from "@nestjs/common";
import ccxt, { Dictionary, Exchange, Ticker, Tickers, Trade } from "ccxt";
import { readFileSync } from "fs";
import { FeedId, FeedValueData } from "../dto/provider-requests.dto";
import { BaseDataFeed } from "./base-feed";
import { retry, sleepFor } from "src/utils/retry";

type networks = "local-test" | "from-env" | "coston2" | "coston" | "songbird";

enum FeedCategory {
  None = 0,
  Crypto = 1,
  FX = 2,
  Commodity = 3,
  Stock = 4,
}

const CONFIG_PREFIX = "src/config/";
const RETRY_TRADES_MS = 100;
const RETRY_TICKERS_MS = 60 * 1000;
const RETRY_BACKOFF_MS = 10_000;
const QUERY_LIMIT = 50;

interface FeedConfig {
  feed: FeedId;
  sources: {
    exchange: string;
    symbol: string;
  }[];
}

interface PriceInfo {
  price: number;
  time: number;
  exchange: string;
  amount: number;
}

interface VolumeInfo {
  volume: number;
  time: number;
  exchange: string;
}

const usdtToUsdFeedId: FeedId = { category: FeedCategory.Crypto.valueOf(), name: "USDT/USD" };
const usdcToUsdFeedId: FeedId = { category: FeedCategory.Crypto.valueOf(), name: "USDC/USD" };
const daiToUsdFeedId: FeedId = { category: FeedCategory.Crypto.valueOf(), name: "DAI/USD" };

export class CcxtFeed implements BaseDataFeed {
  private readonly logger = new Logger(CcxtFeed.name);
  protected initialized = false;
  private config: FeedConfig[];

  private readonly exchangeByName: Map<string, Exchange> = new Map();

  /** Symbol -> Exchange -> Price */
  private readonly prices: Map<string, Map<string, PriceInfo>> = new Map();

  /** Symbol -> Exchange -> Volume */
  private readonly volumes: Map<string, Map<string, VolumeInfo>> = new Map();

  async start() {
    this.config = this.loadConfig();

    const exchangeToSymbols = new Map<string, Set<string>>();
    for (const feed of this.config) {
      for (const source of feed.sources) {
        const symbols = exchangeToSymbols.get(source.exchange) || new Set();
        symbols.add(source.symbol);
        exchangeToSymbols.set(source.exchange, symbols);
      }
    }

    await this.initializeExchange(new Set(exchangeToSymbols.keys()));

    for (const [exchangeName, symbols] of exchangeToSymbols) {
      const exchange = this.exchangeByName.get(exchangeName);
      if (exchange === undefined) {
        this.logger.warn(`Exchange ${exchangeName} not worked`);
        continue;
      }

      let marketIds: string[] = this.getMarketIds(exchange, symbols);
      void this.watchTrades(exchange, marketIds, exchangeName);
      void this.watchTickers(exchange, marketIds, exchangeName);
    }
  }

  private async initializeExchange(exchangeNames: Set<string>) {
    this.logger.log(`Connecting to exchanges: ${JSON.stringify(Array.from(exchangeNames))}`);

    const loadExchanges = [];
    for (const exchangeName of exchangeNames) {
      try {
        const exchange: Exchange = new ccxt.pro[exchangeName]({ newUpdates: true });
        this.exchangeByName.set(exchangeName, exchange);
        loadExchanges.push([exchangeName, retry(async () => exchange.loadMarkets(), 2, RETRY_BACKOFF_MS, this.logger)]);
      } catch (e) {
        this.logger.warn(`Failed to initialize ${exchangeName}, ignoring: ${e}`);
      }
    }

    for (const [exchangeName, loadExchange] of loadExchanges) {
      try {
        await loadExchange;
        this.logger.log(`Exchange ${exchangeName} initialized`);
      } catch (e) {
        this.logger.warn(`Failed to load markets for ${exchangeName}, ignoring: ${e}`);
      }
    }

    this.initialized = true;
    this.logger.log(`Exchange initialization finished`);
  }

  private getMarketIds(exchange: Exchange, symbols: Set<string>): string[] {
    const marketIds: string[] = [];
    for (const symbol of symbols) {
      const market = exchange.markets?.[symbol];
      if (market === undefined) {
        this.logger.warn(`Market not found for ${symbol} on exchange ${exchange.name}`);
        continue;
      }
      marketIds.push(market.id);
    }
    return marketIds;
  }

  private async watchTrades(exchange: Exchange, marketIds: string[], exchangeName: string) {
    if (marketIds.length === 0) {
      return;
    }

    if (exchange.has["watchTrades"]) {
      (async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            const trades: Trade[] = [];
            for (const marketId of marketIds) {
              const tradesForSymbol = await exchange.watchTrades(marketId, null, QUERY_LIMIT);
              if (tradesForSymbol.length > 0) trades.push(tradesForSymbol[tradesForSymbol.length - 1]);
            }

            this.processTrades(trades, exchangeName);
            await sleepFor(RETRY_TRADES_MS);
          } catch (e) {
            this.logger.error(`Failed to watch trades for ${exchange.name}: ${e}`);
            await sleepFor(RETRY_BACKOFF_MS);
          }
        }
      })()
    }
    
    if (exchange.has["watchTradesForSymbols"]) {
      (async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            const trades = await retry(
              async () => exchange.watchTradesForSymbols(marketIds, null, QUERY_LIMIT),
              RETRY_BACKOFF_MS
            );

            this.processTrades(trades, exchangeName);
            await sleepFor(RETRY_TRADES_MS);
          } catch (e) {
            this.logger.error(`Failed to watch trades for ${exchange.name}: ${e}`);
            await sleepFor(RETRY_BACKOFF_MS);
          }
        }
      })()
    }
    
    if (exchange.has["fetchTrades"]) {
      (async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            const trades: Trade[] = [];
            for (const marketId of marketIds) {
              const until = Date.now();
              const since = until - 60*60*1000;
              const tradesForSymbol = await exchange.fetchTrades(marketId, since, QUERY_LIMIT, { "until": until });
              if (tradesForSymbol.length > 0)
                trades.push(tradesForSymbol[tradesForSymbol.length - 1]);
            }

            this.processTrades(trades, exchangeName);
            await sleepFor(RETRY_TRADES_MS);
          } catch (e) {
            this.logger.error(`Failed to fetch trades for ${exchange.name}: ${e}`);
            await sleepFor(RETRY_BACKOFF_MS);
          }
        }
      })()
    }
  }

  private async processTrades(trades: Trade[], exchangeName: string) {
    for (const trade of trades) {
      let unifiedSymbol: string = trade.symbol.match(/^([a-zA-Z0-9]+\/[a-zA-Z0-9]+).*$/)[1];
      const prices = this.prices.get(unifiedSymbol) || new Map<string, PriceInfo>();

      prices.set(exchangeName, {
        price: trade.price,
        time: trade.timestamp,
        exchange: exchangeName,
        amount: trade.amount,
      });
      this.prices.set(unifiedSymbol, prices);
    }
  }

  private async watchTickers(exchange: Exchange, marketIds: string[], exchangeName: string) {
    if (marketIds.length === 0) {
      return;
    }

    if (exchange.has["watchTickers"]) {
      (async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            const tickers = await retry(
              async () => exchange.watchTickers(marketIds),
              RETRY_BACKOFF_MS
            );

            this.processTickers(tickers, exchangeName);
            await sleepFor(RETRY_TICKERS_MS);
          } catch (e) {
            this.logger.error(`Failed to watch trades for ${exchange.name}: ${e}`);
            await sleepFor(RETRY_BACKOFF_MS);
          }
        }
      })()
    }

    if (exchange.has["fetchTickers"]) {
      (async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            const tickers = await retry(
              async () => exchange.fetchTickers(marketIds),
              RETRY_BACKOFF_MS
            );

            this.processTickers(tickers, exchangeName);
            await sleepFor(RETRY_TICKERS_MS);
          } catch (e) {
            this.logger.error(`Failed to watch trades for ${exchange.name}: ${e}`);
            await sleepFor(RETRY_BACKOFF_MS);
          }
        }
      })()
    }
  }

  private async processTickers(tickers: Dictionary<Ticker>, exchangeName: string) {
    for (const ticker of Object.values(tickers)) {
      let unifiedSymbol: string = ticker.symbol.match(/^([a-zA-Z0-9]+\/[a-zA-Z0-9]+).*$/)[1];
      const volumes = this.volumes.get(unifiedSymbol) || new Map<string, VolumeInfo>();

      volumes.set(exchangeName, {
        volume: ticker.quoteVolume,
        time: ticker.timestamp,
        exchange: exchangeName,
      });
      this.volumes.set(unifiedSymbol, volumes);
    }
  }

  async getValues(feeds: FeedId[]): Promise<FeedValueData[]> {
    const promises = feeds.map(feed => this.getValue(feed));
    return Promise.all(promises);
  }

  async getValue(feed: FeedId): Promise<FeedValueData> {
    const price = await this.getFeedPrice(feed);
    return {
      feed: feed,
      value: price,
    };
  }

  private async getFeedPrice(feedId: FeedId): Promise<number | undefined> {
    const config = this.config.find(config => feedsEqual(config.feed, feedId));
    if (!config) {
      this.logger.warn(`No config found for ${JSON.stringify(feedId)}`);
      return undefined;
    }

    // For handling various quote currencies with price and volume info
    const symbolToInfos: Map<string, Array<[number, number]>> = new Map();
    for (const source of config.sources) {
      const priceInfo = this.prices.get(source.symbol)?.get(source.exchange);
      if (!priceInfo || priceInfo.amount === undefined)
        continue;

      const volumeInfo = this.volumes.get(source.symbol)?.get(source.exchange);
      if (!volumeInfo || volumeInfo.volume == undefined)
        continue;

      const infos: Array<[number, number]> = symbolToInfos.get(source.symbol) || new Array();
      infos.push([priceInfo.price, volumeInfo.volume]);
      symbolToInfos.set(source.symbol, infos);
    }

    // Adjust for USDx to USD if needed
    const usdPriceVolume: Array<[number, number]> = new Array();
    for (const [symbol, infos] of symbolToInfos) {
      let mapped: Array<[number, number]> = new Array();

      if (symbol.endsWith("USD")) {
        mapped = infos;
      }

      if (symbol.endsWith("USDC")) {
        const usdcToUsd = await this.getFeedPrice(usdcToUsdFeedId);
        if (usdcToUsd === undefined) {
          this.logger.warn(`Unable to retrieve USDC to USD conversion rate for ${symbol}`);
          continue;
        }
        mapped = infos.map(([price, volume]) => [price*usdcToUsd, volume*usdcToUsd]);
      }

      if (symbol.endsWith("USDT")) {
        const usdtToUsd = await this.getFeedPrice(usdtToUsdFeedId);
        if (usdtToUsd === undefined) {
          this.logger.warn(`Unable to retrieve USDT to USD conversion rate for ${symbol}`);
          continue;
        }
        mapped = infos.map(([price, volume]) => [price*usdtToUsd, volume*usdtToUsd]);
      }

      if (symbol.endsWith("DAI")) {
        const daiToUsd = await this.getFeedPrice(daiToUsdFeedId);
        if (daiToUsd === undefined) {
          this.logger.warn(`Unable to retrieve DAI to USD conversion rate for ${symbol}`);
          continue;
        }
        mapped = infos.map(([price, volume]) => [price*daiToUsd, volume*daiToUsd]);
      }

      usdPriceVolume.push(...mapped);
    }

    // If no valid prices were found, return undefined
    if (usdPriceVolume.length === 0) {
      this.logger.warn(`Unable to calculate median for ${JSON.stringify(feedId)}`);
      return undefined;      
    }

    // Sort by price ascending
    usdPriceVolume.sort((x, y) => x[0] - y[0]);

    // Calculate a sum of volume
    let totalVolume = 0;
    for (const [, volume] of usdPriceVolume)
      totalVolume += volume;

    // Find wieghted median
    let cumulativeVolume = 0;
    for (const [price, volume] of usdPriceVolume) {
      cumulativeVolume += volume;

      if (cumulativeVolume >= totalVolume / 2)
        return price;
    }

    // If fail to find weighted median, just return median
    const mid = Math.floor(usdPriceVolume.length / 2);
    return usdPriceVolume.length % 2 !== 0
        ? usdPriceVolume[mid][0]
        : (usdPriceVolume[mid-1][0] + usdPriceVolume[mid][0]) / 2;
  }

  private loadConfig() {
    const network = process.env.NETWORK as networks;
    let configPath: string;
    switch (network) {
      case "local-test":
        configPath = CONFIG_PREFIX + "test-feeds.json";
        break;
      default:
        configPath = CONFIG_PREFIX + "feeds-optimized.json";
    }

    try {
      const jsonString = readFileSync(configPath, "utf-8");
      const config: FeedConfig[] = JSON.parse(jsonString);

      if (config.find(feed => feedsEqual(feed.feed, usdtToUsdFeedId)) === undefined) {
        throw new Error("Must provide USDT feed sources, as it is used for USD conversion.");
      }

      this.logger.log(`Supported feeds: ${JSON.stringify(config.map(f => f.feed))}`);
      return config;
    } catch (err) {
      this.logger.error("Error parsing JSON config:", err);
      throw err;
    }
  }
}

function feedsEqual(a: FeedId, b: FeedId): boolean {
  return a.category === b.category && a.name === b.name;
}
