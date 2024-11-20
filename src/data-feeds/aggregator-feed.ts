import { Logger } from "@nestjs/common";
import { readFileSync } from "fs";
import { FeedId, FeedValueData } from "../dto/provider-requests.dto";
import { BaseDataFeed } from "./base-feed";
import { retry, sleepFor } from "src/utils/retry";

type networks = "local-test" | "from-env" | "coston2" | "coston" | "songbird";

const CONFIG_PREFIX = "src/config/";
const RETRY_BACKOFF_MS = 10_000;

interface FeedConfig {
  feed: FeedId;
  sources: {
    exchange: string;
    symbol: string;
  }[];
}

interface CoingeckoMarketResponse {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  high_24h: number;
  low_24h: number;
  last_updated: string;
}

const COINGECKO_API_URL = "https://pro-api.coingecko.com/api/v3/";

export class AggregatorFeed implements BaseDataFeed {
  private readonly logger = new Logger(AggregatorFeed.name);
  protected initialized = false;
  private config: FeedConfig[];

  /** Symbol -> price */
  private readonly prices: Map<string, number> = new Map();

  async start() {
    this.config = this.loadConfig();

    // 1. Get coin ids from coin list
    const coinIds = new Map<string, string>();
    try {
      const response = await fetch(COINGECKO_API_URL + "coins/list", {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-cg-pro-api-key": process.env.COINGECKO_API_KEY,
        },
      });
      if (response.ok === false) {
        throw new Error(`Failed to get coin ids: ${response.statusText}`);
      }
      const coins = await response.json();

      for (const coin of coins) {
        coinIds.set(coin.symbol, coin.id);
      }
    } catch (e) {
      this.logger.error(e);
      return;
    }

    const coingekcoIds = this.config.map(feed => coinIds.get(feedNameToCoingeckoSymbol(feed.feed.name)));

    this.initialized = true;

    this.logger.log(`Initialization done, watching trades...`);

    // 2. Start polling
    void this.startPolling(coingekcoIds);
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

  private async startPolling(coingekcoIds: string[]) {
    this.logger.log(`Watching trades for ${coingekcoIds.length} on CoinGecko...`);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const markets = await retry(
          async () =>
            fetch(COINGECKO_API_URL + `coins/markets?vs_currency=usd&ids=${coingekcoIds.join(",")}`, {
              method: "GET",
              headers: {
                "Content-Type": "application/json",
                "x-cg-pro-api-key": process.env.COINGECKO_API_KEY,
              },
            }).then(response => response.json()),
          RETRY_BACKOFF_MS
        );

        this.processMarkets(markets);

        await sleepFor(90000);
      } catch (e) {
        this.logger.error(`Failed to fetch markets ${e}`);
        await sleepFor(10_000);
      }
    }
  }

  private processMarkets(markets: CoingeckoMarketResponse[]) {
    markets.forEach(market => {
      this.prices.set(market.symbol, market.current_price);
    });
  }

  private async getFeedPrice(feedId: FeedId): Promise<number | undefined> {
    const config = this.config.find(config => feedsEqual(config.feed, feedId));
    if (!config) {
      this.logger.warn(`No config found for ${JSON.stringify(feedId)}`);
      return undefined;
    }

    return this.prices.get(feedNameToCoingeckoSymbol(feedId.name));
  }

  private loadConfig() {
    const network = process.env.NETWORK as networks;
    let configPath: string;
    switch (network) {
      case "local-test":
        configPath = CONFIG_PREFIX + "test-feeds.json";
        break;
      default:
        configPath = CONFIG_PREFIX + "feeds.json";
    }

    try {
      const jsonString = readFileSync(configPath, "utf-8");
      const config: FeedConfig[] = JSON.parse(jsonString);

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

function feedNameToCoingeckoSymbol(name: string): string {
  return name.replace("/USD", "").toLowerCase();
}