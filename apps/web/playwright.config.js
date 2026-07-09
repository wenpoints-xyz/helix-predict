const { devices } = require("@playwright/test");

module.exports = {
  testDir: "./tests",
  timeout: 20000,
  fullyParallel: true,
  webServer: {
    command: "python3 -m http.server 8099",
    cwd: __dirname,
    url: "http://127.0.0.1:8099",
    reuseExistingServer: true,
    timeout: 20000
  },
  use: { baseURL: "http://127.0.0.1:8099" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
};
