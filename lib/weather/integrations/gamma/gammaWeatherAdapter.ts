import { extractWeatherMarkets, type RawPage } from "../../inventory/gammaInventory";

/** The adapter boundary intentionally delegates to the existing canonical identity extractor. */
export function adaptGammaWeatherPage(page: RawPage) { return extractWeatherMarkets(page); }
