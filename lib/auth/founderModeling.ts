// /founder/modeling is a permanent PUBLIC, read-only dashboard (Founder decision, issue #550): no login, token
// or cookie. It exposes aggregate analytics only; premium, payment and every other API keep their own auth.
const ROBOTS = "noindex, nofollow";

export const PUBLIC_MODELING_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=120",
  "X-Robots-Tag": ROBOTS,
};

export const PUBLIC_MODELING_ERROR_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": ROBOTS,
};
