import fs from "fs";
import fetch from "node-fetch";

type FeedResponse = {
  data: {
    feed: {
      category: string;
      name: string;
    };
    value: number;
  }[];
};

type FeedItem = { feed: { category: string; name: string } };

async function fetchFeedValues(url: string, payload: object): Promise<FeedResponse["data"]> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data: FeedResponse = await response.json();

    if (data && Array.isArray(data.data)) {
      return data.data;
    } else {
      console.error(`Unexpected response format from ${url}`, data);
      return [];
    }
  } catch (error) {
    console.error(`Error fetching feed values from ${url}:`, error);
    return [];
  }
}

async function fetchFromMultipleUrls(urls: string[]) {
  const feeds: FeedItem[] = JSON.parse(fs.readFileSync("src/config/feeds.json", "utf-8"));

  const payload = {
    feeds: feeds.map(item => ({
      category: item.feed.category,
      name: item.feed.name,
    })),
  };

  try {
    const servers = await Promise.all(urls.map(url => fetchFeedValues(url, payload)));

    // Generate output for Google Sheets
    const googleSheetsData = feeds
      .map((item, index) => {
        const output: (string | number)[] = [item.feed.name];
        servers.forEach(server => {
          output.push(server[index].value);
        });

        return output.join("\t");
      })
      .join("\n");

    let output = "Feed";
    servers.forEach((server, index) => {
      output += `\tServer ${index + 1}`;
    });
    output += "\n" + googleSheetsData;

    // write as file
    fs.writeFileSync("./feed-values.txt", output);

    console.log("Copy the following data into Google Sheets:");
    console.log(googleSheetsData);
  } catch (error) {
    console.error("Error fetching from multiple URLs:", error);
  }
}

// Process command line arguments
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: yarn get-feed-values [urls...]");
  process.exit(1);
}

void fetchFromMultipleUrls(args);
