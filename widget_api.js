require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT;

// ==================== CONFIGURATION ====================
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const DOMAIN = process.env.DOMAIN;
const SECRET_KEY = process.env.SECRET_KEY;
// =======================================================

/**
 * Executes a network health check on a target subdomain URL.
 * It treats the service as ONLINE if it responds with any standard HTTP profile,
 * but flags it as OFFLINE if it hits network drops or Cloudflare origin timeout errors.
 */
async function checkSubdomainStatus(url) {
  try {
    const response = await axios.get(url, {
      timeout: 4000, // 4-second timeout limit per subdomain
      headers: { "User-Agent": "JarvisWidgetMonitor/1.0" },
      validateStatus: function (status) {
        // Resolve the promise for ANY status code (2xx, 3xx, 4xx, 5xx).
        // Even a 401 Unauthorized or 403 Forbidden means the container is up and responding!
        return true;
      },
    });

    // Cloudflare returns 521, 522, or 523 if the tunnel/origin server goes down
    if ([521, 522, 523].includes(response.status)) {
      return "OFFLINE";
    }

    return "ONLINE";
  } catch (error) {
    // Catch connection refused, DNS resolution drops, or severe timeouts
    return "OFFLINE";
  }
}

app.get("/api/status", async (req, res) => {
  // Inbound security guardrail check
  if (req.headers["x-widget-secret"] !== SECRET_KEY) {
    return res.status(403).json({ error: "Unauthorized access token mapping" });
  }

  try {
    // 1. Automatically fetch all A, AAAA, and CNAME records from Cloudflare
    const cfResponse = await axios.get(
      `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records?type=CNAME,A,AAAA&per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      },
    );

    const records = cfResponse.data.result;
    const statusReport = {};
    const healthCheckPromises = [];

    // 2. Loop through records, isolate subdomains, and queue concurrent health checks
    for (const record of records) {
      const hostname = record.name;

      // Target valid subdomains while skipping the root domain and wildcard entries
      if (
        hostname.endsWith(DOMAIN) &&
        hostname !== DOMAIN &&
        !hostname.startsWith("*")
      ) {
        const url = `https://${hostname}`;

        // Process health checks concurrently via Promises for maximum execution speed
        const promise = checkSubdomainStatus(url).then((status) => {
          // Clean up the key string for your widget (e.g., "panel.devanshtyagi.me" -> "panel")
          const cleanName = hostname.replace(`.${DOMAIN}`, "");
          statusReport[cleanName] = status;
        });

        healthCheckPromises.push(promise);
      }
    }

    // 3. Resolve all concurrent background ping tasks
    await Promise.all(healthCheckPromises);

    // Sort the object alphabetically by subdomain name for a clean widget UI read
    const sortedStatusReport = Object.keys(statusReport)
      .sort()
      .reduce((obj, key) => {
        obj[key] = statusReport[key];
        return obj;
      }, {});

    res.json(sortedStatusReport);
  } catch (err) {
    res.status(500).json({
      error: "Failed to execute automated subdomain tracking pass",
      details: err.message,
    });
  }
});

app.listen(PORT, () =>
  console.log(`Automated Subdomain Status Engine active on port ${PORT}`),
);
