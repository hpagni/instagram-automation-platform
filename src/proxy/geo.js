// IP geolocation lookup. Given an IP, returns its city, region, country,
// timezone, and latitude/longitude, plus the network operator string and ASN
// when the provider reports them.
//
// Primary lookup is ipinfo.io; if it is down or rate-limits, it falls back to
// ip-api.com (free tier is HTTP-only, ~45 req/min, no key). The request is made
// directly (not through any proxy) so the result describes the target IP, not
// the caller's egress.

const axios = require('axios');

async function fetchFromIpinfo(ip) {
  const headers = {};
  if (process.env.IPINFO_TOKEN) headers.Authorization = `Bearer ${process.env.IPINFO_TOKEN}`;
  const r = await axios.get(`https://ipinfo.io/${ip}/json`, { headers, timeout: 15_000 });
  const d = r.data || {};
  if (!d.timezone) throw new Error(`ipinfo(${ip}): no timezone in response`);
  const [latStr, lonStr] = String(d.loc || '').split(',');
  const latitude = Number(latStr);
  const longitude = Number(lonStr);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error(`ipinfo(${ip}): invalid loc='${d.loc}'`);
  }
  // ipinfo's `org` is shaped "AS<num> <Name>" e.g. "AS33363 Charter Communications".
  const org = d.org || null;
  const asnMatch = org ? String(org).match(/^AS(\d+)\b/) : null;
  return {
    ip,
    city: d.city || null,
    region: d.region || null,
    country: d.country || null,
    timezone: d.timezone,
    latitude,
    longitude,
    org,
    asn: asnMatch ? Number(asnMatch[1]) : null,
  };
}

async function fetchFromIpApi(ip) {
  // ipinfo's `region` returns the full state name (e.g. "California"), so map
  // ip-api's `regionName` (not `region`, which is the 2-letter code) to match.
  // The free tier of ip-api requires HTTP; HTTPS is paid.
  const fields = 'status,message,country,countryCode,regionName,city,lat,lon,timezone,as,asname,isp';
  const r = await axios.get(`http://ip-api.com/json/${ip}?fields=${fields}`, { timeout: 15_000 });
  const d = r.data || {};
  if (d.status !== 'success') throw new Error(`ip-api(${ip}): ${d.message || 'non-success status'}`);
  if (!d.timezone) throw new Error(`ip-api(${ip}): no timezone in response`);
  const latitude = Number(d.lat);
  const longitude = Number(d.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error(`ip-api(${ip}): invalid lat/lon ${d.lat},${d.lon}`);
  }
  const org = d.as || (d.asname ? `${d.asname}` : null);
  const asnMatch = d.as ? String(d.as).match(/^AS(\d+)\b/) : null;
  return {
    ip,
    city: d.city || null,
    region: d.regionName || null,
    country: d.countryCode || null,
    timezone: d.timezone,
    latitude,
    longitude,
    org,
    asn: asnMatch ? Number(asnMatch[1]) : null,
  };
}

async function resolveIpLocation(ip) {
  if (!ip) throw new Error('resolveIpLocation: ip required');
  try {
    return await fetchFromIpinfo(ip);
  } catch (e) {
    console.warn(`[geo] ipinfo failed (${e.message}); falling back to ip-api.com`);
    return await fetchFromIpApi(ip);
  }
}

module.exports = { resolveIpLocation };
