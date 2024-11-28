import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { readFileSync } from "fs";
import { ExampleProviderService } from "src/app.service";
import { FeedValueData } from "src/dto/provider-requests.dto";
import { sleepFor } from "src/utils/retry";

const CONFIG_PREFIX = "src/config/";

@Injectable()
export class MedianDeltaCalculatorService implements OnModuleInit {
  private readonly logger = new Logger(MedianDeltaCalculatorService.name);
  private readonly baseVotingEpochTs = 1658430000; // 2022-11-21T00:00:00Z in Unix timestamp
  private readonly votingEpochInterval = 90;
  private readonly votingEpochSnapshotOffset = 15; // Save feed values on -15 seconds of the voting epoch
  private readonly deltaCalculationTimeout = 5;
  private readonly feedApiUrl = "https://flare-systems-explorer.flare.network/backend-url/api/v0/";

  private readonly feedItems: JsonFeedItem[] = [];
  private readonly deltaByName: Map<string, number> = new Map();
  private readonly submittedFeedValues: Map<number, FeedValueData[]> = new Map();

  constructor(
    @Inject("EXAMPLE_PROVIDER_SERVICE")
    private readonly exampleProviderService: ExampleProviderService
  ) {
    // Initialize the delta map with 0 for each feed
    this.feedItems = this.loadConfig();

    this.feedItems.forEach(item => {
      this.deltaByName.set(item.feed.name, 0);
    });
  }

  async onModuleInit() {
    void this.start();
  }

  async start() {
    this.logger.log("Starting median delta calculator service");

    void this.startMedianPolling();
    void this.startSnapshotLoop();
  }

  // 1. Fetch median feed values of the feed values saved on the previous step
  // 2. Calculate the median delta of each feed
  async startMedianPolling() {
    this.logger.log("Median Polling | Starting polling for median delta calculation");

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Calculate the delay to the next voting epoch. Aim to save feed values on -15 seconds of the voting epoch
      const elapsed = this.secondsSinceMidnight();
      const delay =
        this.votingEpochInterval -
        (elapsed % this.votingEpochInterval) -
        this.votingEpochSnapshotOffset -
        this.deltaCalculationTimeout;
      const adjustedDelay = delay <= 0 ? delay + this.votingEpochInterval : delay;

      // Wait for the next voting epoch
      this.logger.log(`Median Polling | Waiting ${adjustedDelay} seconds before starting polling...`);
      await sleepFor(adjustedDelay * 1000);

      const prevVotingEpochId = this.getCurrentVotingEpochId() - 1;

      if (!this.submittedFeedValues[prevVotingEpochId]) {
        this.logger.log(
          `Median Polling | Last submitted feed values for ${prevVotingEpochId} not found. Skipping this round...`
        );
        continue;
      }

      const cachedLastSubmittedFeedValues = this.submittedFeedValues[prevVotingEpochId];

      try {
        // 1. Calculate delta from the last submitted feed values (if exists)
        const { fromTs, toTs } = this.getVotingEpochRange(prevVotingEpochId);

        // Fetch data for all feeds in parallel
        const apiPromises = this.feedItems.map(feed =>
          this.fetchFtsoFeed(feed.feed.name, fromTs, toTs, prevVotingEpochId)
        );
        const apiResults = await Promise.all(apiPromises);
        const filteredApiResults = apiResults.filter(item => item);

        if (filteredApiResults.length === 0) {
          this.logger.error(`Median Polling | No data found for any feed in voting epoch ${prevVotingEpochId}`);
          continue;
        }

        // 2. Update delta map
        apiResults.forEach(feed => {
          if (!feed) return;

          const lastSubmittedFeed = cachedLastSubmittedFeedValues.find(item => item.feed.name === feed.name);
          if (!lastSubmittedFeed) {
            this.logger.warn(`Median Polling | No last submitted feed found for ${feed.name}`);
            return;
          }

          const delta = feed.median - lastSubmittedFeed.value;
          this.deltaByName.set(feed.name, delta);
        });

        this.logger.log(
          `Median Polling | Fetched delta values of previous voting epoch ${prevVotingEpochId} successfully`
        );
      } catch (e) {
        this.logger.error(`${e}`);
        await sleepFor(10_000);
      }

      // Wait for the next voting epoch
      this.logger.log(`Waiting ${adjustedDelay} seconds before starting polling...`);
      await sleepFor(adjustedDelay * 1000);
    }
  }

  // 1. Save local feed values on every -15 seconds of the voting epoch
  async startSnapshotLoop() {
    this.logger.log("Snapshot Loop | Starting current feed values snapshot loop");

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Calculate the delay to the next voting epoch. Aim to save feed values on -15 seconds of the voting epoch
      const elapsed = this.secondsSinceMidnight();
      const delay = this.votingEpochInterval - (elapsed % this.votingEpochInterval) - this.votingEpochSnapshotOffset;
      const adjustedDelay = delay <= 0 ? delay + this.votingEpochInterval : delay;

      // Wait for the next voting epoch
      this.logger.log(`Snapshot Loop | Waiting ${adjustedDelay} seconds before starting polling...`);
      await sleepFor(adjustedDelay * 1000);

      const targetVotingEpochId = this.getCurrentVotingEpochId() + 1;

      try {
        await this.updateLastSubmittedFeedValues(targetVotingEpochId);

        this.logger.log(
          `Snapshot Loop | Updated ${this.submittedFeedValues[targetVotingEpochId].length} last submitted feed values for voting epoch ${targetVotingEpochId}`
        );
      } catch (e) {
        this.logger.error(`${e}`);
        await sleepFor(10_000);
      }
    }
  }

  // Helper function to convert name to feed_name format
  convertToFeedName(name: string): string {
    const asciiHex = name
      .split("")
      .map(char => char.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("");

    const baseFeedName = `01${asciiHex}`;
    const totalLength = 42; // Desired length of the final feed_name
    const paddingLength = totalLength - baseFeedName.length;

    // Add the required padding
    const paddedFeedName = baseFeedName + "0".repeat(Math.max(0, paddingLength));
    return paddedFeedName;
  }

  // Fetch data for a single feed
  async fetchFtsoFeed(
    name: string,
    fromTs: number,
    toTs: number,
    targetVotingRoundId: number
  ): Promise<FeedResponseNormalized | undefined> {
    const feedName = this.convertToFeedName(name);
    const apiUrl = `${this.feedApiUrl}/ftso_feed?feed_name=${feedName}&from_ts=${fromTs}&to_ts=${toTs}&relative=false`;

    try {
      const response = await fetch(apiUrl);
      if (!response.ok) throw new Error(`Error fetching data for ${name}: ${response.statusText}`);

      const data: FtsoFeedResponse[] = await response.json();
      if (!data.length) {
        this.logger.warn(`No data found for ${name}`);
        return;
      }

      const item = data.find(item => item.voting_round_id === targetVotingRoundId);
      if (!item) {
        this.logger.warn(`No data found for ${name} in voting round ${targetVotingRoundId}`);
        return;
      }

      const [quartileLow, quartileHigh] = item.quartiles;
      const [secondaryLow, secondaryHigh] = item.secondary_bands;

      return {
        name: name,
        median: item.value,
        primaryLow: quartileLow,
        primaryHigh: quartileHigh,
        secondaryLow,
        secondaryHigh,
      };
    } catch (error) {
      this.logger.error(`Error processing ${name}:`, error);
      return;
    }
  }

  async updateLastSubmittedFeedValues(currentVotingEpochId: number) {
    const feedValues = await this.exampleProviderService.getValues(this.feedItems.map(item => item.feed));
    this.submittedFeedValues[currentVotingEpochId] = feedValues;
    this.submittedFeedValues.delete(currentVotingEpochId - 2);
  }

  // Helper function to calculate time range for a given voting epoch
  getVotingEpochRange(votingEpochId: number) {
    const fromTs = this.baseVotingEpochTs + votingEpochId * this.votingEpochInterval;
    const toTs = fromTs + this.votingEpochInterval;
    return { fromTs, toTs };
  }

  // Helper function to calculate the number of seconds since midnight
  secondsSinceMidnight(): number {
    const now = new Date();
    return now.getSeconds() + now.getMinutes() * 60 + now.getHours() * 3600;
  }

  getCurrentVotingEpochId(): number {
    const currentTs = Math.floor(Date.now() / 1000);
    return Math.floor((currentTs - this.baseVotingEpochTs) / this.votingEpochInterval);
  }

  getCurrentDelta(name: string): number {
    return this.deltaByName.get(name) ?? 0;
  }

  // use config of CcxtFeed
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
      const config: JsonFeedItem[] = JSON.parse(jsonString);

      this.logger.log(`Supported feeds: ${JSON.stringify(config.map(f => f.feed))}`);

      return config;
    } catch (err) {
      this.logger.error("Error parsing JSON config:", err);
      throw err;
    }
  }
}
