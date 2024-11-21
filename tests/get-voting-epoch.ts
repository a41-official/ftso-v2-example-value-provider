import fs from "fs";
import fetch from "node-fetch";

type Feed = {
  feed: {
    category: number;
    name: string;
  };
  sources: {
    exchange: string;
    symbol: string;
  }[];
};

type FeedResponse = {
  feed: {
    representation: string;
    feed_name: string;
  };
  quartiles: number[];
  secondary_bands: number[];
  voting_round_id: number;
  value: number;
};

const baseUrl = "https://flare-systems-explorer.flare.network/backend-url/api/v0/ftso_feed";

// Helper function to convert name to feed_name format
const convertToFeedName = (name: string): string => {
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
};

// Helper function to convert human-readable date to timestamp
const convertDateToTimestamp = (dateStr: string): number => {
  return Math.floor(new Date(dateStr).getTime() / 1000);
};

// Fetch data for a single feed
const fetchFeedData = async (
  name: string,
  fromTs: number,
  toTs: number,
  targetVotingRoundId: number
): Promise<{
  representation: string;
  median: number;
  primaryLow: number;
  primaryHigh: number;
  secondaryLow: number;
  secondaryHigh: number;
}> => {
  const feedName = convertToFeedName(name);
  const apiUrl = `${baseUrl}?feed_name=${feedName}&from_ts=${fromTs}&to_ts=${toTs}&relative=false`;

  try {
    const response = await fetch(apiUrl);
    if (!response.ok) throw new Error(`Error fetching data for ${name}: ${response.statusText}`);

    const data: FeedResponse[] = await response.json();
    if (!data.length) {
      console.warn(`No data found for ${name}`);
      return;
    }

    const item = data.find(item => item.voting_round_id === targetVotingRoundId);
    if (!item) {
      console.warn(`No data found for ${name} in voting round ${targetVotingRoundId}`);
      return;
    }

    const [quartileLow, quartileHigh] = item.quartiles;
    const [secondaryLow, secondaryHigh] = item.secondary_bands;

    return {
      representation: item.feed.representation,
      median: item.value,
      primaryLow: quartileLow,
      primaryHigh: quartileHigh,
      secondaryLow,
      secondaryHigh,
    };
  } catch (error) {
    console.error(`Error processing ${name}:`, error);
    return;
  }
};

// Function to process all feeds
const processAllFeeds = async (fromDate: string, toDate: string, targetVotingRoundId: number): Promise<void> => {
  // Load feeds.json
  const feeds: Feed[] = JSON.parse(fs.readFileSync("./src/config/feeds.json", "utf-8"));

  const fromTs = convertDateToTimestamp(fromDate);
  const toTs = convertDateToTimestamp(toDate);

  // Fetch data for all feeds in parallel
  const promises = feeds.map(feed => fetchFeedData(feed.feed.name, fromTs, toTs, targetVotingRoundId));
  const results = await Promise.all(promises);

  const filtered = results.filter(Boolean);

  // Generate output for Google Sheets
  const googleSheetsData = filtered
    .map(row =>
      [row.representation, row.median, row.primaryLow, row.primaryHigh, row.secondaryLow, row.secondaryHigh].join("\t")
    )
    .join("\n");

  console.log("Copy the following data into Google Sheets:");
  console.log(googleSheetsData);

  const output = "Feed\tMedian\tPrimary Low\tPrimary High\tSecondary Low\tSecondary High\n" + googleSheetsData;

  // write as file
  fs.writeFileSync("./output.txt", output);
};

// Example usage
const fromDate = "2024-11-21T04:00:00Z"; // Start date in ISO format
const toDate = "2024-11-21T05:00:00Z"; // End date in ISO format
const targetVotingRoundId = 819255; // Voting round ID to target

void processAllFeeds(fromDate, toDate, targetVotingRoundId);
