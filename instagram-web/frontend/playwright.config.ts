import {defineConfig,devices} from "@playwright/test";
export default defineConfig({
  testDir:"../browser",testMatch:"*.spec.ts",fullyParallel:false,workers:1,
  use:{baseURL:"http://127.0.0.1:3111",trace:"retain-on-failure"},
  projects:[{name:"desktop",use:{...devices["Desktop Chrome"]}},{name:"mobile",use:{...devices["iPhone 13"],defaultBrowserType:"chromium"}}],
  webServer:{command:"node ../browser/fixture.cjs",url:"http://127.0.0.1:3111/api/health",reuseExistingServer:false,timeout:30000}
});
