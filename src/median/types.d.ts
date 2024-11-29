type JsonFeedItem = {
  feed: {
    category: number;
    name: string;
  };
  sources: {
    exchange: string;
    symbol: string;
  }[];
};

type FtsoFeedResponse = {
  feed: {
    representation: string;
    feed_name: string;
  };
  quartiles: number[];
  secondary_bands: number[];
  voting_round_id: number;
  value: number;
};

type FeedResponseNormalized = {
  name: string;
  median: number;
  primaryLow: number;
  primaryHigh: number;
  secondaryLow: number;
  secondaryHigh: number;
};

type ProviderFeedVoteResponse = {
  feed: {
    representation: string;
    feed_name: string;
  };
  voting_round_id: number;
  value: number;
};

type networks = "local-test" | "from-env" | "coston2" | "coston" | "songbird";
